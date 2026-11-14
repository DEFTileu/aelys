"""In-process hub that pushes fresh snapshots to connected boards when an owner's data changes.

Mapper events (not sync_changes) mark owners dirty, because notifications and focus sessions never
reach the sync log. Marks ride on the writing session and fire only after its commit.
"""
from __future__ import annotations

import asyncio
import logging
from weakref import WeakValueDictionary
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.core import db as database
from app.core.models import CalendarEvent, FocusSession, Notification, SyncChange, Task
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, object_session

logger = logging.getLogger(__name__)

DEBOUNCE_SECONDS = 0.25
SEND_TIMEOUT_SECONDS = 5.0
CLOSE_TIMEOUT_SECONDS = 2.0
BUILD_TIMEOUT_SECONDS = 10.0  # a hung build must not hold an owner's lock forever
SEND_FAILED_CLOSE_CODE = 1011
REPLACED_CLOSE_CODE = 4000
_DIRTY_KEY = "aelys_companion_dirty_owners"

Send = Callable[[dict], Awaitable[None]]
Close = Callable[[int], Awaitable[None]]


@dataclass(eq=False)
class _Connection:
    device_id: str
    owner_id: str
    send: Send
    close: Close | None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)  # one send at a time keeps snapshots in order


class CompanionHub:
    def __init__(self) -> None:
        self.debounce = DEBOUNCE_SECONDS  # tests shrink this
        self._connections: dict[str, _Connection] = {}
        self._connection_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
        self._pending: dict[str, asyncio.Task[None]] = {}  # owners inside their debounce window
        self._background: set[asyncio.Task[None]] = set()
        self._owner_locks: dict[str, asyncio.Lock] = {}  # build + send as one unit keeps an older snapshot from landing last

    def connection_lock(self, device_id: str) -> asyncio.Lock:
        lock = self._connection_locks.get(device_id)
        if lock is None:
            lock = asyncio.Lock()
            self._connection_locks[device_id] = lock
        return lock

    def register(self, device_id: str, owner_id: str, send: Send, close: Close | None = None) -> Callable[[], None]:
        connection = _Connection(device_id, owner_id, send, close)
        previous = self._connections.get(device_id)
        self._connections[device_id] = connection
        if previous and previous.close:
            self._spawn(self._close(previous, REPLACED_CLOSE_CODE))

        def unregister() -> None:
            # A replaced socket's late unregister must not evict its successor.
            if self._connections.get(device_id) is connection:
                del self._connections[device_id]
        return unregister

    def is_online(self, device_id: str) -> bool:
        return device_id in self._connections

    def online_owners(self) -> set[str]:
        return {c.owner_id for c in self._connections.values()}

    async def send_to_device(self, device_id: str, message: dict) -> bool:
        connection = self._connections.get(device_id)
        if connection is None:
            return False
        return await self._send(connection, message)

    async def close_device(self, device_id: str, code: int) -> None:
        connection = self._connections.pop(device_id, None)
        if connection:
            await self._close(connection, code)

    def mark_owner_dirty(self, owner_id: str) -> None:
        if owner_id in self._pending or not any(c.owner_id == owner_id for c in self._connections.values()):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(self._flush(owner_id))
        self._pending[owner_id] = task
        self._track(task)

    async def wait_idle(self, timeout: float | None = None) -> None:
        """Wait for background pushes and closes; with a timeout, whatever is still running then is cancelled."""
        try:
            await asyncio.wait_for(self._drain(), timeout)
        except TimeoutError:
            for task in list(self._background):
                task.cancel()
            await self._drain()

    async def _drain(self) -> None:
        while self._background:
            await asyncio.gather(*self._background, return_exceptions=True)

    def _spawn(self, coro: Awaitable[None]) -> None:
        self._track(asyncio.ensure_future(coro))

    def _track(self, task: asyncio.Task[None]) -> None:
        self._background.add(task)
        task.add_done_callback(self._done)

    def _done(self, task: asyncio.Task[None]) -> None:
        self._background.discard(task)
        if not task.cancelled() and (error := task.exception()):
            logger.warning("companion hub task failed reason=%s", type(error).__name__)

    async def push_snapshot(self, device_id: str) -> bool:
        """Send one board a fresh snapshot, ordered against the owner's other pushes; False if it did not go out."""
        connection = self._connections.get(device_id)
        return connection is not None and await self._push(connection.owner_id, device_id)

    async def _flush(self, owner_id: str) -> None:
        try:
            await asyncio.sleep(self.debounce)
        finally:  # commits landing during the rebuild schedule a fresh pass; also on cancel
            if self._pending.get(owner_id) is asyncio.current_task():
                del self._pending[owner_id]
        await self._push(owner_id, None)

    async def _push(self, owner_id: str, device_id: str | None) -> bool:
        async with self._owner_locks.setdefault(owner_id, asyncio.Lock()):
            targets = [c for c in self._connections.values() if c.owner_id == owner_id and device_id in (None, c.device_id)]
            if not targets:
                return False
            # lazy: snapshot imports domains, which import this hub
            from app.companion.snapshot import build_snapshot, for_device
            from app.companion.weather import refresh_if_due

            try:
                await refresh_if_due(owner_id, datetime.now(UTC))  # at most one fetch per 30 minutes; a failure keeps the cache
            except Exception as exc:  # noqa: BLE001 - weather must never stop a push
                logger.warning("companion weather refresh failed owner=%s reason=%s", owner_id, type(exc).__name__)
            try:
                async with database.SessionLocal() as db:
                    snapshot = await asyncio.wait_for(build_snapshot(db, owner_id, datetime.now(UTC)), BUILD_TIMEOUT_SECONDS)
                    views = [await for_device(db, snapshot, c.device_id) for c in targets]  # a board in lost mode gets no data
            except Exception as exc:  # noqa: BLE001 - a failed or hung rebuild must not kill the hub
                logger.warning("companion snapshot rebuild failed owner=%s reason=%s", owner_id, type(exc).__name__)
                return False
            return all(await asyncio.gather(*(self._send(c, {"type": "snapshot", "snapshot": view.model_dump(mode="json")}) for c, view in zip(targets, views, strict=True))))

    async def _send(self, connection: _Connection, message: dict) -> bool:
        try:
            async with connection.lock:
                await asyncio.wait_for(connection.send(message), SEND_TIMEOUT_SECONDS)
            return True
        except Exception as exc:  # noqa: BLE001 - a dead or slow socket is dropped, others keep going
            logger.info("companion send failed device=%s reason=%s", connection.device_id, type(exc).__name__)
            if self._connections.get(connection.device_id) is connection:
                del self._connections[connection.device_id]
            await self._close(connection, SEND_FAILED_CLOSE_CODE)  # the board reconnects and gets a fresh snapshot
            return False

    @staticmethod
    async def _close(connection: _Connection, code: int) -> None:
        if connection.close:
            try:
                await asyncio.wait_for(connection.close(code), CLOSE_TIMEOUT_SECONDS)
            except Exception as exc:  # noqa: BLE001 - already gone is fine
                logger.info("companion close failed device=%s reason=%s", connection.device_id, type(exc).__name__)


hub = CompanionHub()

_WATCHED = (Task, CalendarEvent, Notification, FocusSession)
_installed = False


def mark_dirty(db: AsyncSession, owner_id: str) -> None:
    """For writes that bypass mapper events (Core UPDATE/INSERT): push a snapshot after this session commits."""
    db.sync_session.info.setdefault(_DIRTY_KEY, set()).add(owner_id)


def _note_sync_change(_mapper: Any, _connection: Any, target: Any) -> None:
    # Every record_domain_change writes a SyncChange, so this covers task/event writes made with Core UPDATEs.
    if target.resource_kind in ("task", "event"):
        _note_owner(_mapper, _connection, target)


def _note_owner(_mapper: Any, _connection: Any, target: Any) -> None:
    session = object_session(target)
    if session is not None and target.owner_id:
        session.info.setdefault(_DIRTY_KEY, set()).add(target.owner_id)


def _after_commit(session: Session) -> None:
    for owner_id in session.info.pop(_DIRTY_KEY, ()):
        hub.mark_owner_dirty(owner_id)


def _after_rollback(session: Session, *_: Any) -> None:
    session.info.pop(_DIRTY_KEY, None)


def _after_soft_rollback(session: Session, previous_transaction: Any) -> None:
    # A rolled-back savepoint leaves the outer transaction's marks alone; a spurious mark only costs a refresh.
    if previous_transaction.parent is None:
        session.info.pop(_DIRTY_KEY, None)


def install_change_listeners() -> None:
    global _installed
    if _installed:
        return
    _installed = True
    for model in _WATCHED:
        for name in ("after_insert", "after_update", "after_delete"):
            event.listen(model, name, _note_owner)
    event.listen(SyncChange, "after_insert", _note_sync_change)
    event.listen(Session, "after_commit", _after_commit)
    event.listen(Session, "after_rollback", _after_rollback)
    event.listen(Session, "after_soft_rollback", _after_soft_rollback)
