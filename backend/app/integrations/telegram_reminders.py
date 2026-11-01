"""Owner-only Telegram reminders with durable, at-most-once send claims.

A claimed attempt is terminal even after timeout or process death. The generic
Notification survives; Telegram cannot provide an idempotent send operation.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.ai.crypto import decrypt_secret
from app.ai.errors import PolicyDenied
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.core import db as database
from app.core.models import (
    CalendarEvent,
    CalendarReminder,
    Notification,
    Task,
    TaskReminder,
)
from app.domains.briefings import TERMINAL_TASK_STATUSES
from app.domains.recurrence import next_occurrence, utc
from app.sync.change_log import lock_owner
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .telegram_models import TelegramIntegration

DEADLINE_PREFIX = 'telegram-deadline:'
DEADLINE_OFFSETS = (18_000, 600)
BATCH_LIMIT = 200
logger = logging.getLogger(__name__)


def _wall_boundary(day: date, clock: time, zone: ZoneInfo, *, latest: bool) -> datetime:
    """Resolve folds conservatively; a skipped end becomes the first real minute."""
    wall = datetime.combine(day, clock)
    for minute in range(26 * 60):
        candidate = wall + timedelta(minutes=minute)
        instants = [candidate.replace(tzinfo=zone, fold=fold).astimezone(UTC) for fold in (0, 1)]
        valid = [value for value in instants if value.astimezone(zone).replace(tzinfo=None) == candidate]
        if valid:
            return max(valid) if latest else min(valid)
    raise ValueError('Quiet-hours boundary has no real local instant')


def quiet_delivery_at(item: TelegramIntegration, at: datetime) -> datetime:
    """Return UTC now, or the end of the containing local quiet-hours interval.

    The repeated autumn hour stays quiet until the *last* end instant. Spring
    gaps end at the first real minute at/after the configured wall-clock end.
    """
    instant = utc(at)
    if not item.quiet_start or not item.quiet_end or item.quiet_start == item.quiet_end:
        return instant
    start, end = time.fromisoformat(item.quiet_start), time.fromisoformat(item.quiet_end)
    zone = ZoneInfo(item.timezone)
    local_day = instant.astimezone(zone).date()
    for day in (local_day - timedelta(days=1), local_day):
        end_day = day + timedelta(days=1) if start > end else day
        lower = _wall_boundary(day, start, zone, latest=False)
        upper = _wall_boundary(end_day, end, zone, latest=True)
        if lower <= instant < upper:
            return upper
    return instant


@dataclass(frozen=True)
class _ReminderPolicy:
    name: str
    required_scope: str
    external_effect: bool = False


def _authorize(item: TelegramIntegration, scope: str, *, external: bool = False) -> None:
    # Permission comes from the persisted owner-bound integration and schedule,
    # never from the task title or another sender's instructions.
    ServerPolicyEngine().authorize(_ReminderPolicy(scope, scope, external), ToolCall(scope, {}),
        PermissionContext(actor=f'telegram:{item.id}', scopes=frozenset({scope}),
                          allow_external_effects=external, policy_id='telegram-owner-reminder'))


def _deadline_key(owner_id: str, task_id: str, due: datetime, offset: int) -> str:
    raw = f'{owner_id}:{task_id}:{utc(due).isoformat()}:{offset}'
    return DEADLINE_PREFIX + hashlib.sha256(raw.encode()).hexdigest()


def _insert(db: AsyncSession, model: Any):
    dialect = db.get_bind().dialect.name
    if dialect == 'postgresql':
        return pg_insert(model)
    if dialect == 'sqlite':
        return sqlite_insert(model)
    raise ValueError('Reminder claims require PostgreSQL or SQLite')


async def _seed_deadlines(db: AsyncSession, item: TelegramIntegration) -> None:
    if not item.deadline_reminders:
        return
    tasks = (await db.execute(select(Task).where(Task.owner_id == item.owner_id,
        Task.deleted_at.is_(None), Task.due_at.is_not(None),
        func.lower(Task.status).not_in(TERMINAL_TASK_STATUSES)))).scalars()
    for task in tasks:
        if task.due_at is None:
            continue
        for offset in DEADLINE_OFFSETS:
            await db.execute(_insert(db, TaskReminder).values(owner_id=item.owner_id,
                task_id=task.id, channel='telegram', notify_at=utc(task.due_at) - timedelta(seconds=offset),
                idempotency_key=_deadline_key(item.owner_id, task.id, task.due_at, offset)
            ).on_conflict_do_nothing(index_elements=['idempotency_key']))


async def _claim(db: AsyncSession, reminder: TaskReminder | CalendarReminder,
                 at: datetime, **values: Any) -> bool:
    model = type(reminder)
    result = await db.execute(update(model).where(model.id == reminder.id,
        model.owner_id == reminder.owner_id, model.version == reminder.version,
        model.deleted_at.is_(None), model.channel == 'telegram',
        model.reminder_status == 'pending', model.notify_at <= at,
    ).values(version=model.version + 1, **values).execution_options(synchronize_session=False))
    return int(getattr(result, 'rowcount', 0) or 0) == 1


async def _notification(db: AsyncSession, item: TelegramIntegration,
                        reminder: TaskReminder | CalendarReminder, resource_id: str,
                        occurrence: datetime) -> bool:
    kind = 'task' if isinstance(reminder, TaskReminder) else 'event'
    identity = f'{kind}:{reminder.id}:{utc(occurrence).isoformat()}'
    key = 'telegram-reminder:' + hashlib.sha256(identity.encode()).hexdigest()
    result = await db.execute(_insert(db, Notification).values(owner_id=item.owner_id,
        kind='telegram.reminder', title='Scheduled reminder', body=None, dedup_key=key,
        data_json={f'{kind}_id': resource_id, 'reminder_id': reminder.id},
    ).on_conflict_do_nothing(index_elements=['dedup_key']).returning(Notification.id))
    return result.scalar_one_or_none() is not None


async def _claim_due(db: AsyncSession, item: TelegramIntegration, at: datetime) -> list[str]:
    """Claim schedules and fallbacks in the caller's transaction, without sends."""
    texts: list[str] = []
    deferred = quiet_delivery_at(item, at)
    zone = ZoneInfo(item.timezone)
    tasks = (await db.execute(select(TaskReminder, Task).outerjoin(Task,
        (TaskReminder.task_id == Task.id) & (Task.owner_id == item.owner_id)).where(
        TaskReminder.owner_id == item.owner_id, TaskReminder.deleted_at.is_(None),
        TaskReminder.channel == 'telegram', TaskReminder.reminder_status == 'pending',
        TaskReminder.notify_at <= at,
    ).order_by(TaskReminder.notify_at, TaskReminder.id).limit(BATCH_LIMIT))).all()
    for reminder, task in tasks:
        cancelled = task is None or task.deleted_at is not None or task.status.casefold() in TERMINAL_TASK_STATUSES
        if reminder.idempotency_key.startswith(DEADLINE_PREFIX):
            valid_keys = {_deadline_key(item.owner_id, task.id, task.due_at, offset)
                          for offset in DEADLINE_OFFSETS} if task and task.due_at else set()
            cancelled = cancelled or not item.deadline_reminders or reminder.idempotency_key not in valid_keys
        if cancelled:
            await _claim(db, reminder, at, reminder_status='cancelled')
            continue
        if deferred > at:
            await _claim(db, reminder, at, notify_at=deferred)
            continue
        assert task is not None
        try:
            _authorize(item, 'notifications.write')
        except PolicyDenied:
            continue  # One denied schedule cannot interrupt the other schedules.
        if not await _claim(db, reminder, at, reminder_status='delivered'):
            continue
        if await _notification(db, item, reminder, task.id, reminder.notify_at):
            scheduled = utc(task.due_at or reminder.notify_at).astimezone(zone)
            texts.append(f'Напоминание: {task.title[:1000]}\n{scheduled:%Y-%m-%d %H:%M %Z}')

    events = (await db.execute(select(CalendarReminder, CalendarEvent).outerjoin(CalendarEvent,
        (CalendarReminder.event_id == CalendarEvent.id) & (CalendarEvent.owner_id == item.owner_id)).where(
        CalendarReminder.owner_id == item.owner_id, CalendarReminder.deleted_at.is_(None),
        CalendarReminder.channel == 'telegram', CalendarReminder.reminder_status == 'pending',
        CalendarReminder.notify_at <= at,
    ).order_by(CalendarReminder.notify_at, CalendarReminder.id).limit(BATCH_LIMIT))).all()
    for reminder, event in events:
        if event is None or event.deleted_at is not None:
            await _claim(db, reminder, at, reminder_status='cancelled')
            continue
        occurrence = utc(reminder.occurrence_at or event.starts_at)
        offset = reminder.offset_seconds
        if offset is None:
            offset = int((occurrence - utc(reminder.notify_at)).total_seconds())
        if deferred > at:
            await _claim(db, reminder, at, notify_at=deferred,
                         offset_seconds=offset, occurrence_at=occurrence)
            continue
        try:
            upcoming = next_occurrence(event.starts_at, event.timezone, event.rrule, occurrence)
            _authorize(item, 'notifications.write')
        except (PolicyDenied, ValueError):
            continue  # Invalid/denied schedules do not block unrelated reminders.
        values: dict[str, Any] = {'reminder_status': 'pending' if upcoming else 'delivered',
                                  'offset_seconds': offset, 'occurrence_at': upcoming or occurrence}
        if upcoming:
            values['notify_at'] = upcoming - timedelta(seconds=offset)
        if not await _claim(db, reminder, at, **values):
            continue
        if await _notification(db, item, reminder, event.id, occurrence):
            scheduled = occurrence.astimezone(zone)
            texts.append(f'Событие: {event.title[:1000]}\n{scheduled:%Y-%m-%d %H:%M %Z}')
    return texts


async def deliver_telegram_reminders(integration_id: str, *, at: datetime | None = None) -> None:
    """One bounded connector step; no scheduler and no automatic send retries."""
    from . import telegram_service as service

    instant = utc(at or datetime.now(UTC))
    async with database.SessionLocal() as db:
        item = await db.get(TelegramIntegration, integration_id)
        if item is None:
            return
        await lock_owner(db, item.owner_id)
        await db.refresh(item)
        if not item.enabled or item.deleted_at or not item.encrypted_token or not item.owner_telegram_id:
            return
        try:
            _authorize(item, 'reminders.write')
        except PolicyDenied:
            return
        await _seed_deadlines(db, item)
        texts = await _claim_due(db, item, instant)
        # Claims, occurrence advancement and all generic fallbacks are durable
        # before the first request. A crash can lose a DM, never resend it.
        await db.commit()
        for text in texts:
            await db.refresh(item)
            if not item.enabled or item.deleted_at or not item.encrypted_token or not item.owner_telegram_id:
                return
            try:
                _authorize(item, 'telegram.notify_owner', external=True)
                async with service.TelegramClient(decrypt_secret(item.encrypted_token)) as client:
                    await client.send_message(item.owner_telegram_id, text)
            except Exception:  # noqa: BLE001 - durable fallback survives policy/transport failures; never log content
                logger.info('Telegram reminder delivery unavailable')
