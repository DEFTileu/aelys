"""What the desk board may show: a small, privacy-filtered view of the owner's day."""
from __future__ import annotations

import logging
from datetime import UTC, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.companion.state import lost_mode_on
from app.core.models import CalendarEvent, FocusSession, Notification, Task
from app.domains.api import focus_elapsed
from app.domains.briefings import TERMINAL_TASK_STATUSES
from app.domains.google_calendar_projection import project_google_calendar_events
from app.domains.recurrence import utc
from app.integrations.telegram_models import TelegramIntegration
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

logger = logging.getLogger(__name__)

# Only these notification kinds may show a title on the board; every other kind is counted, never named.
ALLOWED_NOTICE_PREFIXES = ("task.", "calendar.", "focus.")
EVENT_WINDOW = timedelta(days=7)
MAX_NOTICES = 5
MAX_TITLE_CHARS = 80  # with MAX_SNAPSHOT_BYTES keeps a full snapshot under the 4096-byte frame cap even for Cyrillic text
MAX_TASKS_TODAY = 5
MAX_EVENTS_UPCOMING = 4
MAX_SNAPSHOT_BYTES = 3900  # the board's frame cap is 4096 and the websocket wrapper adds ~30 bytes; lists shrink to fit


def _clip(title: str) -> str:
    return title if len(title) <= MAX_TITLE_CHARS else title[: MAX_TITLE_CHARS - 1] + "…"


class _Utc(BaseModel):
    """SQLite hands back naive datetimes; the wire is always UTC."""
    model_config = ConfigDict(from_attributes=True)

    @field_validator("*", mode="after")
    @classmethod
    def _to_utc(cls, value):
        return utc(value) if isinstance(value, datetime) else value

    @field_validator("title", check_fields=False)
    @classmethod
    def _clip_title(cls, value: str) -> str:
        return _clip(value)


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
    today_done: int  # v1.1: tasks due in the owner's day that are completed ...
    today_total: int  # ... out of those completed plus still open (cancelled and deleted ones count in neither)
    other_unread_count: int  # unread notifications of kinds the board may not name
    tasks_today: list[SnapTask] = []  # v1.2: open tasks due today or overdue, upcoming first; max 5
    events_upcoming: list[SnapEvent] = []  # v1.2: events from now through the end of tomorrow; max 4


DONE_STATUSES = ("done", "completed", "complete")


async def _local_day(db: AsyncSession, owner_id: str, now: datetime) -> tuple[datetime, datetime, datetime]:
    """UTC starts of the owner's local today, tomorrow and the day after, cut in the Telegram integration's time zone (UTC if none)."""
    name = (await db.execute(select(TelegramIntegration.timezone).where(TelegramIntegration.owner_id == owner_id))).scalar_one_or_none()
    try:
        tz = ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo("UTC")
    day = now.astimezone(tz).date()
    return tuple(datetime.combine(day + timedelta(days=n), time.min, tz).astimezone(UTC) for n in (0, 1, 2))  # type: ignore[return-value]


async def _today_counts(db: AsyncSession, owner_id: str, lower: datetime, upper: datetime) -> tuple[int, int]:
    """The owner's local day is cut like briefings.build_agenda cuts it."""
    status = func.lower(Task.status)
    done, total = (await db.execute(select(func.count().filter(status.in_(DONE_STATUSES)), func.count()).where(
        Task.owner_id == owner_id, Task.deleted_at.is_(None), Task.due_at >= lower, Task.due_at < upper,
        or_(status.in_(DONE_STATUSES), status.not_in(TERMINAL_TASK_STATUSES))))).one()
    return done, total


def _fit(snapshot: CompanionSnapshot) -> CompanionSnapshot:
    """Drops list tail entries (later events first) until the JSON fits one board frame; the v1 fields are never touched."""
    while len(snapshot.model_dump_json().encode()) > MAX_SNAPSHOT_BYTES and (snapshot.events_upcoming or snapshot.tasks_today):
        field = "events_upcoming" if snapshot.events_upcoming else "tasks_today"
        snapshot = snapshot.model_copy(update={field: getattr(snapshot, field)[:-1]})
    return snapshot


async def for_device(db: AsyncSession, snapshot: CompanionSnapshot, device_id: str) -> CompanionSnapshot:
    """What this board may see: while its lost mode is on, only the unread count and the timestamp."""
    if not await lost_mode_on(db, device_id):
        return snapshot
    return snapshot.model_copy(update={"next_task": None, "next_event": None, "notices": [], "focus": None, "overdue_count": 0, "today_done": 0, "today_total": 0,
                                               "tasks_today": [], "events_upcoming": []})


async def build_snapshot(db: AsyncSession, owner_id: str, now: datetime) -> CompanionSnapshot:
    now = utc(now)
    open_task = (Task.owner_id == owner_id, Task.deleted_at.is_(None), Task.due_at.is_not(None),
                 func.lower(Task.status).not_in(TERMINAL_TASK_STATUSES))
    next_task = (await db.execute(select(Task).where(*open_task, Task.due_at >= now).order_by(Task.due_at, Task.id).limit(1))).scalar_one_or_none()
    overdue = (await db.execute(select(func.count()).select_from(Task).where(*open_task, Task.due_at < now))).scalar_one()
    today, tomorrow, after_tomorrow = await _local_day(db, owner_id, now)
    # Not yet due first, in next_task's order, then the overdue ones oldest first; so tasks_today[0] is next_task when it is due today.
    tasks_today = list((await db.execute(select(Task).where(*open_task, Task.due_at < tomorrow).order_by(Task.due_at < now, Task.due_at, Task.id).limit(MAX_TASKS_TODAY))).scalars())

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
    # events_upcoming leads with the same pick as next_event, then the rest in time order; it ends with tomorrow.
    in_window = [item for item in projected if item[1] < after_tomorrow]
    lead = next((item for item in in_window if not item[0].all_day), in_window[0] if in_window else None)
    upcoming = [SnapEvent(id=e.id, title=e.title, starts_at=st, ends_at=en, all_day=e.all_day)
                for e, st, en in ([lead] + [item for item in in_window if item is not lead] if lead else [])[:MAX_EVENTS_UPCOMING]]

    unread = (Notification.owner_id == owner_id, Notification.deleted_at.is_(None), Notification.read_at.is_(None))
    unread_count = (await db.execute(select(func.count()).select_from(Notification).where(*unread))).scalar_one()
    other_unread = (await db.execute(select(func.count()).select_from(Notification).where(
        *unread, *(func.substr(Notification.kind, 1, len(p)) != p for p in ALLOWED_NOTICE_PREFIXES)))).scalar_one()
    today_done, today_total = await _today_counts(db, owner_id, today, tomorrow)
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

    return _fit(CompanionSnapshot(
        generated_at=now, next_task=SnapTask.model_validate(next_task) if next_task else None, overdue_count=overdue,
        next_event=next_event, unread_count=unread_count, notices=[SnapNotice.model_validate(n) for n in notices if n.kind.startswith(ALLOWED_NOTICE_PREFIXES)], focus=focus,
        today_done=today_done, today_total=today_total, other_unread_count=other_unread,
        tasks_today=[SnapTask.model_validate(t) for t in tasks_today], events_upcoming=upcoming))
