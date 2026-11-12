"""What the desk board may show: a small, privacy-filtered view of the owner's day."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Literal

from app.core.models import CalendarEvent, FocusSession, Notification, Task
from app.domains.api import focus_elapsed
from app.domains.briefings import TERMINAL_TASK_STATUSES
from app.domains.google_calendar_projection import project_google_calendar_events
from app.domains.recurrence import utc
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

logger = logging.getLogger(__name__)

# Only these notification kinds may show a title on the board; every other kind is counted, never named.
ALLOWED_NOTICE_PREFIXES = ("task.", "calendar.", "focus.")
EVENT_WINDOW = timedelta(days=7)
MAX_NOTICES = 5


class _Utc(BaseModel):
    """SQLite hands back naive datetimes; the wire is always UTC."""
    model_config = ConfigDict(from_attributes=True)

    @field_validator("*", mode="after")
    @classmethod
    def _to_utc(cls, value):
        return utc(value) if isinstance(value, datetime) else value


class SnapTask(_Utc):
    id: str
    title: str
    due_at: datetime


class SnapEvent(_Utc):
    id: str
    title: str
    starts_at: datetime
    ends_at: datetime | None
    all_day: bool


class SnapNotice(_Utc):
    id: str
    kind: str
    title: str
    created_at: datetime


class SnapFocus(_Utc):
    id: str
    status: Literal["active", "paused"]
    mode: str
    started_at: datetime
    elapsed_seconds: int


class CompanionSnapshot(_Utc):
    generated_at: datetime
    next_task: SnapTask | None
    overdue_count: int
    next_event: SnapEvent | None
    unread_count: int
    notices: list[SnapNotice]  # max 5, newest first
    focus: SnapFocus | None


async def build_snapshot(db: AsyncSession, owner_id: str, now: datetime) -> CompanionSnapshot:
    now = utc(now)
    open_task = (Task.owner_id == owner_id, Task.deleted_at.is_(None), Task.due_at.is_not(None),
                 func.lower(Task.status).not_in(TERMINAL_TASK_STATUSES))
    next_task = (await db.execute(select(Task).where(*open_task, Task.due_at >= now).order_by(Task.due_at, Task.id).limit(1))).scalar_one_or_none()
    overdue = (await db.execute(select(func.count()).select_from(Task).where(*open_task, Task.due_at < now))).scalar_one()

    # Same projection as GET /calendar/occurrences: it needs every owner row, deleted exception placeholders included.
    # It never reads the description, so that heavy column stays unloaded.
    events = list((await db.execute(select(CalendarEvent).where(CalendarEvent.owner_id == owner_id).options(defer(CalendarEvent.description)).limit(10001))).scalars())
    projected: list = []
    if len(events) > 10000:
        logger.warning("companion snapshot: calendar too large to project owner=%s", owner_id)
    else:
        try:
            projected = project_google_calendar_events(events, now, now + EVENT_WINDOW)
        except (ValueError, TypeError, KeyError) as exc:  # bad rrule/timezone (ZoneInfoNotFoundError is a KeyError) must not take the board offline
            logger.warning("companion snapshot: calendar projection failed owner=%s reason=%s", owner_id, type(exc).__name__)
    # A timed event that is ongoing or upcoming wins; an all-day event only shows when no timed one is in the window.
    chosen = next((item for item in projected if not item[0].all_day), projected[0] if projected else None)
    next_event = None
    if chosen:
        event, start, end = chosen
        next_event = SnapEvent(id=event.id, title=event.title, starts_at=start, ends_at=end, all_day=event.all_day)

    unread = (Notification.owner_id == owner_id, Notification.deleted_at.is_(None), Notification.read_at.is_(None))
    unread_count = (await db.execute(select(func.count()).select_from(Notification).where(*unread))).scalar_one()
    # substr == p, not LIKE: LIKE is case-insensitive on SQLite and would admit kinds such as 'Task.x'.
    notices = (await db.execute(select(Notification).where(*unread, or_(*(func.substr(Notification.kind, 1, len(p)) == p for p in ALLOWED_NOTICE_PREFIXES)))
                                .order_by(Notification.created_at.desc(), Notification.id).limit(MAX_NOTICES))).scalars()

    session = (await db.execute(select(FocusSession).where(FocusSession.owner_id == owner_id, FocusSession.deleted_at.is_(None),
                                                           FocusSession.status.in_(("active", "paused"))).limit(1))).scalar_one_or_none()
    focus = None
    if session:
        until = utc(session.paused_at) if session.status == "paused" and session.paused_at else now
        focus = SnapFocus(id=session.id, status=session.status, mode=session.mode, started_at=session.started_at,
                          elapsed_seconds=focus_elapsed(utc(session.started_at), session.paused_seconds, until))

    return CompanionSnapshot(
        generated_at=now, next_task=SnapTask.model_validate(next_task) if next_task else None, overdue_count=overdue,
        next_event=next_event, unread_count=unread_count, notices=[SnapNotice.model_validate(n) for n in notices if n.kind.startswith(ALLOWED_NOTICE_PREFIXES)], focus=focus)
