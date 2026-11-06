"""Commit-time automation events for domain writes.

Events are queued on the writing session and dispatched only after its commit,
so rules never see rolled-back data and never run inside the caller's transaction.
"""
from __future__ import annotations

import asyncio
import logging
from contextvars import ContextVar
from typing import Any

from app.core import db as database
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# True inside automation-driven writes: their own changes must not enqueue new events (loop guard).
_running_automation: ContextVar[bool] = ContextVar("_running_automation", default=False)
_PENDING_KEY = "aelys_automation_events"
_tasks: set[asyncio.Task[None]] = set()


def enqueue(db: AsyncSession, owner_id: str, event_kind: str, event_id: str, payload: dict[str, Any]) -> None:
    if _running_automation.get():
        return
    pending: list[tuple[str, str, str, dict[str, Any]]] = db.sync_session.info.setdefault(_PENDING_KEY, [])
    if any(queued[2] == event_id for queued in pending):
        return
    pending.append((owner_id, event_kind, event_id, payload))


def _schedule(session: Session) -> None:
    events = session.info.pop(_PENDING_KEY, None)
    if not events:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(_run(events))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def _drop(session: Session, *_: Any) -> None:
    session.info.pop(_PENDING_KEY, None)


event.listen(Session, "after_commit", _schedule)
event.listen(Session, "after_rollback", _drop)
event.listen(Session, "after_soft_rollback", _drop)


async def _run(events: list[tuple[str, str, str, dict[str, Any]]]) -> None:
    from app.automation.api import dispatch_event  # lazy: api imports this module

    _running_automation.set(True)  # this task's own context; no reset needed
    for owner_id, event_kind, event_id, payload in events:
        try:
            async with database.SessionLocal() as db:
                await dispatch_event(db, owner_id, event_kind, event_id, payload)
        except Exception as exc:  # noqa: BLE001 - one failing rule must not stop the others
            logger.info("automation event %s failed: %s", event_kind, type(exc).__name__)


async def wait_for_automations() -> None:
    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)
