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

# A task in any of these statuses is finished; mirrors the web UI's set (apps/web/src/views/tasks/taskModel.ts).
FINISHED_STATUSES = frozenset({"done", "completed", "complete", "closed", "cancelled"})


def _block_done(block: object, progress: dict) -> bool:
    """Malformed lesson data counts as not done, never as an error."""
    key = block.get("key") if isinstance(block, dict) else None
    entry = progress.get(key) if isinstance(key, str) else None
    return isinstance(entry, dict) and bool(entry.get("done"))


def _tz(name: str | None) -> tzinfo:
    try:
        return ZoneInfo(name) if name else UTC
    except (ZoneInfoNotFoundError, ValueError):  # a bad stored zone falls back to UTC
        return UTC


async def day_unlocked(db: AsyncSession, owner_id: str, day: date) -> bool:
    """Unlocked when today's English lesson is fully done, or there are tasks due today and all are completed."""
    lesson = await _lesson_for(db, owner_id, day)
    if lesson is not None:
        progress = lesson.progress_json if isinstance(lesson.progress_json, dict) else {}
        content = lesson.content_json if isinstance(lesson.content_json, dict) else {}
        blocks = content.get("blocks")
        if isinstance(blocks, list) and blocks and all(_block_done(b, progress) for b in blocks):
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
    return bool(statuses) and all((s or "").lower() in FINISHED_STATUSES for s in statuses)
