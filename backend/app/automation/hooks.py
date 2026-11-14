"""Durable, commit-time automation event delivery."""
from __future__ import annotations

import asyncio
import logging
from contextvars import ContextVar
from datetime import timedelta
from typing import Any

from app.core import db as database
from app.core.models import AutomationOutbox, now
from sqlalchemy import delete, event, inspect, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)
_running_automation: ContextVar[bool] = ContextVar("_running_automation", default=False)
_PENDING_KEY = "aelys_automation_events"
_tasks: set[asyncio.Task[None]] = set()


def enqueue(db: AsyncSession, owner_id: str, event_kind: str, event_id: str, payload: dict[str, Any]) -> None:
    if _running_automation.get():
        return
    pending = db.sync_session.info.setdefault(_PENDING_KEY, [])
    for item in pending:
        state = inspect(item)
        if (state.pending or state.persistent) and (item.owner_id, item.kind, item.event_id) == (owner_id, event_kind, event_id):
            return
    item = AutomationOutbox(owner_id=owner_id, kind=event_kind, event_id=event_id, payload=payload)
    db.add(item)
    pending.append(item)


def _schedule(session: Session) -> None:
    if session.in_nested_transaction() or not session.info.pop(_PENDING_KEY, None):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(deliver_pending())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def _drop(session: Session, *_: Any) -> None:
    if not session.in_nested_transaction():
        session.info.pop(_PENDING_KEY, None)


event.listen(Session, "after_commit", _schedule)
event.listen(Session, "after_rollback", _drop)


def _delay(attempt: int) -> timedelta:
    return timedelta(seconds=(30, 120, 600)[attempt - 1] if attempt <= 3 else 3600)


async def deliver_pending() -> None:
    from app.automation.api import dispatch_event

    instant = now()
    async with database.SessionLocal() as db:
        expired = (await db.scalars(select(AutomationOutbox).where(
            AutomationOutbox.created_at <= instant - timedelta(hours=24),
            AutomationOutbox.available_at < instant + timedelta(days=2),
        ).order_by(AutomationOutbox.created_at, AutomationOutbox.id).limit(100))).all()
        for row in expired:
            changed = await db.execute(update(AutomationOutbox).where(
                AutomationOutbox.id == row.id, AutomationOutbox.available_at < instant + timedelta(days=2),
            ).values(available_at=instant + timedelta(days=36500)).execution_options(synchronize_session=False))
            if changed.rowcount:  # type: ignore[attr-defined]  # DML returns CursorResult
                logger.warning("automation event delivery expired: id=%s kind=%s attempts=%s", row.id, row.kind, row.attempts)
        await db.commit()
    async with database.SessionLocal() as db:
        rows = (await db.execute(select(AutomationOutbox.id, AutomationOutbox.attempts).where(
            AutomationOutbox.available_at <= instant,
            AutomationOutbox.created_at > instant - timedelta(hours=24),
        ).order_by(AutomationOutbox.created_at, AutomationOutbox.id).limit(100))).all()
    for event_row_id, attempts in rows:
        async with database.SessionLocal() as db:
            claim = await db.execute(update(AutomationOutbox).where(
                AutomationOutbox.id == event_row_id, AutomationOutbox.attempts == attempts,
                AutomationOutbox.available_at <= instant,
                AutomationOutbox.created_at > instant - timedelta(hours=24),
            ).values(attempts=attempts + 1, available_at=instant + _delay(attempts + 1)).returning(
                AutomationOutbox.owner_id, AutomationOutbox.kind, AutomationOutbox.event_id, AutomationOutbox.payload,
            ))
            item = claim.one_or_none()
            await db.commit()
        if item is None:
            continue
        token = _running_automation.set(True)
        try:
            async with database.SessionLocal() as db:
                await dispatch_event(db, item.owner_id, item.kind, item.event_id, item.payload, outbox=True)
            async with database.SessionLocal() as db:
                await db.execute(delete(AutomationOutbox).where(AutomationOutbox.id == event_row_id, AutomationOutbox.attempts == attempts + 1))
                await db.commit()
        except Exception as exc:  # noqa: BLE001 - retry next eligible tick
            logger.info("automation delivery failed: id=%s error=%s", event_row_id, type(exc).__name__)
            async with database.SessionLocal() as db:
                await db.execute(update(AutomationOutbox).where(
                    AutomationOutbox.id == event_row_id, AutomationOutbox.attempts == attempts + 1,
                ).values(available_at=now() + _delay(attempts + 1)))
                await db.commit()
        finally:
            _running_automation.reset(token)


async def automation_loop() -> None:
    while True:
        try:
            await deliver_pending()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - retry after database errors
            logger.warning("automation delivery worker failed: %s", type(exc).__name__)
        await asyncio.sleep(30)


async def wait_for_automations() -> None:
    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)
