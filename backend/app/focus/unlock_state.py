from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.models import Task
from app.english.lessons import _lesson_for
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

# Placeholders until the AI counters land (Task 3 replaces these two).
AI_GRANTS_LEFT = 3
REQUESTS_LEFT = 10


def _tz(name: str | None) -> tzinfo:
    try:
        return ZoneInfo(name) if name else UTC
    except (ZoneInfoNotFoundError, ValueError):  # a bad stored zone falls back to UTC
        return UTC


async def day_unlocked(db: AsyncSession, owner_id: str, day: date) -> bool:
    """Unlocked when today's English lesson is fully done, or there are tasks due today and all are completed."""
    lesson = await _lesson_for(db, owner_id, day)
    if lesson is not None:
        progress = lesson.progress_json or {}
        blocks = (lesson.content_json or {}).get("blocks") or []
        if blocks and all((progress.get(b["key"]) or {}).get("done") for b in blocks):
            return True
    # Every real zone is within 14h of UTC, so this window holds all tasks that can fall on `day`.
    start = datetime.combine(day - timedelta(days=1), time.min, tzinfo=UTC)
    rows = (await db.execute(
        select(Task.due_at, Task.due_timezone, Task.status).where(
            Task.owner_id == owner_id, Task.deleted_at.is_(None), Task.due_at >= start, Task.due_at < start + timedelta(days=3),
        )
    )).all()
    # SQLite returns naive datetimes; they are stored as UTC.
    statuses = [s for due, tz, s in rows if due.replace(tzinfo=due.tzinfo or UTC).astimezone(_tz(tz)).date() == day]
    return bool(statuses) and all(s == "completed" for s in statuses)
