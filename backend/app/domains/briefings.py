"""Deterministic owner agenda in a local calendar day (including recurrence)."""
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.core.models import CalendarEvent, Task
from app.domains.recurrence import occurrences, utc
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

# Same terminal spellings used by the mounted Tasks client taskModel.ts.
TERMINAL_TASK_STATUSES = ('done', 'completed', 'complete', 'closed', 'cancelled')


@dataclass(frozen=True)
class Agenda:
    day: date
    timezone: str
    due: tuple[str, ...]
    overdue: tuple[str, ...]
    events: tuple[str, ...]


async def build_agenda(db: AsyncSession, owner_id: str, tz: ZoneInfo, at: datetime) -> Agenda:
    day = utc(at).astimezone(tz).date()
    lower = datetime.combine(day, time.min, tz).astimezone(UTC)
    upper = datetime.combine(day + timedelta(days=1), time.min, tz).astimezone(UTC)
    tasks = list((await db.execute(select(Task).where(
        Task.owner_id == owner_id, Task.deleted_at.is_(None), Task.due_at < upper,
        func.lower(Task.status).not_in(TERMINAL_TASK_STATUSES),
    ).order_by(Task.due_at, Task.id))).scalars())
    events = list((await db.execute(select(CalendarEvent).where(
        CalendarEvent.owner_id == owner_id, CalendarEvent.deleted_at.is_(None),
        CalendarEvent.starts_at < upper,
    ).order_by(CalendarEvent.starts_at, CalendarEvent.id))).scalars())
    projected = sorted((start, event.id, event.title) for event in events
                       for start, _ in occurrences(event.starts_at, event.ends_at, event.timezone,
                                                   event.rrule, lower, upper))
    return Agenda(day, tz.key,
                  tuple(t.title for t in tasks if t.due_at and utc(t.due_at) >= lower),
                  tuple(t.title for t in tasks if t.due_at and utc(t.due_at) < lower),
                  tuple(f'{start.astimezone(tz):%H:%M} {title}' for start, _, title in projected))


def format_agenda(agenda: Agenda) -> str:
    lines = [f'{agenda.day.isoformat()} · {agenda.timezone}']
    for label, items in [('Задачи на сегодня', agenda.due), ('Просроченные', agenda.overdue), ('События', agenda.events)]:
        lines.append(f'\n{label}:')
        lines.extend(f'• {text}' for text in items) if items else lines.append('Нет')
    text = '\n'.join(lines)
    return text if len(text) <= 4096 else text[:4050] + '\n… Полный список в Aelys.'


async def build_digest(db: AsyncSession, owner_id: str, tz: ZoneInfo, at: datetime) -> str:
    """Evening delivery extends /today without changing the command's contract."""
    today = await build_agenda(db, owner_id, tz, at)
    tomorrow_at = datetime.combine(today.day + timedelta(days=1), time(12), tz).astimezone(UTC)
    tomorrow = await build_agenda(db, owner_id, tz, tomorrow_at)
    lines = [format_agenda(today), '\nЗавтра:']
    items = (*tomorrow.due, *tomorrow.events)
    lines.extend(f'• {value}' for value in items) if items else lines.append('Нет')
    text = '\n'.join(lines)
    return text if len(text) <= 4096 else text[:4050] + '\n… Полный список в Aelys.'
