"""In-process hub that pushes fresh snapshots to connected boards when an owner's data changes.

Mapper events (not sync_changes) mark owners dirty, because notifications and focus sessions never
reach the sync log. Marks ride on the writing session and fire only after its commit.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from app.companion.snapshot import build_snapshot
from app.core import db as database
from app.core.models import CalendarEvent, FocusSession, Notification, Task
from sqlalchemy import event
from sqlalchemy.orm import Session, object_session

logger = logging.getLogger(__name__)

DEBOUNCE_SECONDS = 0.25
SEND_TIMEOUT_SECONDS = 5.0
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


class CompanionHub:
    def __init__(self) -> None:
        self.debounce = DEBOUNCE_SECONDS  # tests shrink this
        self._connections: dict[str, _Connection] = {}
        self._pending: dict[str, asyncio.Task[None]] = {}  # owners inside their debounce window
        self._background: set[asyncio.Task[None]] = set()

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
        self._pending[owner_id] = task = loop.create_task(self._flush(owner_id))
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def wait_idle(self) -> None:
        while self._background:
            await asyncio.gather(*self._background, return_exceptions=True)

    def _spawn(self, coro: Awaitable[None]) -> None:
        task = asyncio.ensure_future(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _flush(self, owner_id: str) -> None:
        await asyncio.sleep(self.debounce)
        self._pending.pop(owner_id, None)  # commits landing during the rebuild schedule a fresh pass
        targets = [c for c in self._connections.values() if c.owner_id == owner_id]
        if not targets:
            return
        try:
            async with database.SessionLocal() as db:
                snapshot = await build_snapshot(db, owner_id, datetime.now(UTC))
        except Exception as exc:  # noqa: BLE001 - a failed rebuild must not kill the hub
            logger.warning("companion snapshot rebuild failed owner=%s reason=%s", owner_id, type(exc).__name__)
            return
        message = {"type": "snapshot", "snapshot": snapshot.model_dump(mode="json")}
        await asyncio.gather(*(self._send(c, message) for c in targets))

    async def _send(self, connection: _Connection, message: dict) -> bool:
        try:
            await asyncio.wait_for(connection.send(message), SEND_TIMEOUT_SECONDS)
            return True
        except Exception as exc:  # noqa: BLE001 - a dead or slow socket is dropped, others keep going
            logger.info("companion send failed device=%s reason=%s", connection.device_id, type(exc).__name__)
            if self._connections.get(connection.device_id) is connection:
                del self._connections[connection.device_id]
            return False

    @staticmethod
    async def _close(connection: _Connection, code: int) -> None:
        if connection.close:
            try:
                await connection.close(code)
            except Exception as exc:  # noqa: BLE001 - already gone is fine
                logger.info("companion close failed device=%s reason=%s", connection.device_id, type(exc).__name__)


hub = CompanionHub()

_WATCHED = (Task, CalendarEvent, Notification, FocusSession)
_installed = False


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
    event.listen(Session, "after_commit", _after_commit)
    event.listen(Session, "after_rollback", _after_rollback)
    event.listen(Session, "after_soft_rollback", _after_soft_rollback)
