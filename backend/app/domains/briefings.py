"""Deterministic owner agenda in a local calendar day (including recurrence)."""
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.core.models import CalendarEvent, Task
from app.domains.google_calendar_projection import project_google_calendar_events
from app.domains.recurrence import utc
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
        CalendarEvent.owner_id == owner_id,
    ).order_by(CalendarEvent.starts_at, CalendarEvent.id).limit(10001))).scalars())
    if len(events) > 10000:
        raise ValueError('Calendar projection exceeds 10000 records')
    projected = sorted((start, event.id, event.title)
                       for event, start, _ in project_google_calendar_events(events, lower, upper))
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
    lines = ['Завтра:']
    items = (*tomorrow.due, *tomorrow.events)
    lines.extend(f'• {value}' for value in items) if items else lines.append('Нет')
    stagnant = list((await db.execute(select(Task.title).where(
        Task.owner_id == owner_id, Task.deleted_at.is_(None), func.lower(func.trim(Task.status)) == 'in_progress',
        Task.started_at < utc(at) - timedelta(days=7),
    ).order_by(Task.started_at, Task.id).limit(21))).scalars())
    stagnant_lines = ['Застывшие задачи:']
    stagnant_lines.extend(f"• {' '.join(title.split())[:120]}" for title in stagnant[:20]) if stagnant else stagnant_lines.append('Нет')
    if len(stagnant) > 20:
        stagnant_lines.append('… Полный список в Aelys.')
    sections = [format_agenda(today), '\n'.join(lines), '\n'.join(stagnant_lines)]
    text = '\n\n'.join(sections)
    if len(text) <= 4096:
        return text
    # Keep every heading visible even when today's agenda consumes its own limit.
    suffix = '\n… Полный список в Aelys.'
    budget = (4096 - 4) // 3
    return '\n\n'.join(section if len(section) <= budget else section[:budget - len(suffix)] + suffix
                       for section in sections)
