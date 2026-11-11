"""Real SQLite reminder claims; only Telegram's external transport is faked."""
import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from app.ai.crypto import encrypt_secret
from app.core import db as database
from app.core.db import Base
from app.core.models import (
    CalendarEvent,
    CalendarReminder,
    Notification,
    Task,
    TaskReminder,
    User,
)
from app.domains.recurrence import utc
from app.integrations import telegram_service as service
from app.integrations.telegram_models import TelegramIntegration
from app.integrations.telegram_reminders import (
    deliver_telegram_reminders,
    quiet_delivery_at,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

AT = datetime(2026, 11, 5, 12, tzinfo=UTC)
TOKEN = '123456:' + 'r' * 30


@pytest.fixture
async def setup(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/reminders.db')
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(database, 'SessionLocal', sessions)
    sent = []
    fail = False
    gate = None
    entered = asyncio.Event()

    class Transport:
        def __init__(self, token):
            assert token == TOKEN

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def send_message(self, chat_id, text):
            # A separate connection must observe the committed fallback and claim
            # before even the first external request is attempted.
            async with sessions() as session:
                notices = list((await session.execute(select(Notification))).scalars())
                assert notices
                assert all(row.title == 'Scheduled reminder' and row.body is None for row in notices)
                assert all(set(row.data_json) <= {'task_id', 'event_id', 'reminder_id'} for row in notices)
            sent.append((chat_id, text))
            entered.set()
            if gate is not None:
                await gate.wait()
            if fail:
                raise TimeoutError('private transport detail')
            return {'message_id': len(sent)}

    monkeypatch.setattr(service, 'TelegramClient', Transport)
    async with sessions() as session:
        session.add_all([User(id='owner'), User(id='other')])
        session.add(TelegramIntegration(id='integration', owner_id='owner', bot_id=1,
            bot_username='test_bot', bot_name='Test', business_capable=True,
            encrypted_token=encrypt_secret(TOKEN), owner_telegram_id=111))
        await session.commit()

    def failing():
        nonlocal fail
        fail = True

    def blocked():
        nonlocal gate
        gate = asyncio.Event()
        return gate

    try:
        yield SimpleNamespace(sessions=sessions, sent=sent, failing=failing, blocked=blocked, entered=entered)
    finally:
        await engine.dispose()


async def task_reminder(setup, *, name='task', owner='owner', status='todo', deleted=False,
                        notify_at=AT, channel='telegram', due_at=None, due_timezone=None):
    async with setup.sessions() as session:
        session.add(Task(id=name, owner_id=owner, title='Private ' + name, status=status,
                         due_at=due_at, due_timezone=due_timezone, deleted_at=AT if deleted else None))
        session.add(TaskReminder(id=name + '-reminder', owner_id=owner, task_id=name,
            notify_at=notify_at, channel=channel, idempotency_key=name))
        await session.commit()


async def test_due_owner_only_persisted_claim_and_no_replay(setup):
    await task_reminder(setup)
    await task_reminder(setup, name='future', notify_at=AT + timedelta(minutes=1))
    await task_reminder(setup, name='other', owner='other')
    await task_reminder(setup, name='in-app', channel='in_app')
    # A forged owner reference must never reveal a different owner's task.
    async with setup.sessions() as session:
        session.add(TaskReminder(id='forged', owner_id='owner', task_id='other', notify_at=AT,
                                 channel='telegram', idempotency_key='forged'))
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    await deliver_telegram_reminders('integration', at=AT)
    assert len(setup.sent) == 1 and setup.sent[0][0] == 111
    assert 'Private task' in setup.sent[0][1]
    async with setup.sessions() as session:
        assert (await session.get(TaskReminder, 'task-reminder')).reminder_status == 'delivered'
        assert (await session.get(TaskReminder, 'future-reminder')).reminder_status == 'pending'
        assert (await session.get(TaskReminder, 'in-app-reminder')).reminder_status == 'pending'
        assert len(list((await session.execute(select(Notification))).scalars())) == 1


@pytest.mark.parametrize('due_timezone,expected', [
    ('Asia/Almaty', '2026-11-04 23:59 Asia/Almaty'),
    ('Asia/Tokyo', '2026-11-05 03:59 Asia/Tokyo'),
    ('UTC', '2026-11-04 18:59 UTC'),
    (None, '2026-11-04 18:59 UTC'),
    ('Invalid/Legacy', '2026-11-04 18:59 UTC'),
    ('/invalid/absolute', '2026-11-04 18:59 UTC'),
])
async def test_task_timezone_controls_text_without_changing_delivery(setup, due_timezone, expected):
    due = datetime(2026, 11, 4, 18, 59, tzinfo=UTC)
    notify = due - timedelta(minutes=10)
    await task_reminder(setup, due_at=due, due_timezone=due_timezone, notify_at=notify)
    await deliver_telegram_reminders('integration', at=notify - timedelta(seconds=1))
    assert not setup.sent
    await deliver_telegram_reminders('integration', at=notify)
    await deliver_telegram_reminders('integration', at=notify + timedelta(seconds=1))
    assert setup.sent == [(111, f'Напоминание: Private task\n{expected}')]
    async with setup.sessions() as session:
        assert utc((await session.get(Task, 'task')).due_at) == due
        assert utc((await session.get(TaskReminder, 'task-reminder')).notify_at) == notify


async def test_task_without_zone_uses_configured_bot_zone(setup):
    await task_reminder(setup, due_at=AT)
    async with setup.sessions() as session:
        item = await session.get(TelegramIntegration, 'integration')
        item.timezone = 'Asia/Almaty'
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    assert setup.sent == [(111, 'Напоминание: Private task\n2026-11-05 17:00 Asia/Almaty')]


@pytest.mark.parametrize('status,deleted', [('completed', False), ('DONE', False), ('todo', True)])
async def test_terminal_task_cancelled_even_during_quiet_hours(setup, status, deleted):
    await task_reminder(setup, status=status, deleted=deleted)
    async with setup.sessions() as session:
        item = await session.get(TelegramIntegration, 'integration')
        item.quiet_start = '00:00'; item.quiet_end = '23:59'
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    assert not setup.sent
    async with setup.sessions() as session:
        assert (await session.get(TaskReminder, 'task-reminder')).reminder_status == 'cancelled'
        assert not list((await session.execute(select(Notification))).scalars())


async def test_failed_send_keeps_fallback_and_never_retries(setup):
    await task_reminder(setup)
    setup.failing()
    await deliver_telegram_reminders('integration', at=AT)
    await deliver_telegram_reminders('integration', at=AT + timedelta(days=1))
    assert len(setup.sent) == 1
    async with setup.sessions() as session:
        assert len(list((await session.execute(select(Notification))).scalars())) == 1
        assert (await session.get(TaskReminder, 'task-reminder')).reminder_status == 'delivered'


async def test_parallel_workers_cannot_repeat_claim(setup):
    await task_reminder(setup)
    gate = setup.blocked()
    worker = asyncio.create_task(deliver_telegram_reminders('integration', at=AT))
    try:
        await asyncio.wait_for(setup.entered.wait(), 5)
        await deliver_telegram_reminders('integration', at=AT)
        assert len(setup.sent) == 1
    finally:
        gate.set()
        await worker


@pytest.mark.parametrize('timezone,start,end,at,expected', [
    ('Asia/Almaty', '22:00', '08:00', '2026-11-05T18:00:00+00:00', '2026-11-06T03:00:00+00:00'),
    ('UTC', '09:00', '17:00', '2026-11-05T12:00:00+00:00', '2026-11-05T17:00:00+00:00'),
    ('UTC', '09:00', '17:00', '2026-11-05T17:00:00+00:00', '2026-11-05T17:00:00+00:00'),
    ('America/New_York', '22:00', '02:30', '2026-03-08T06:00:00+00:00', '2026-03-08T07:00:00+00:00'),
    ('America/New_York', '00:00', '01:30', '2026-11-01T05:45:00+00:00', '2026-11-01T06:30:00+00:00'),
    ('America/New_York', '00:00', '01:30', '2026-11-01T06:15:00+00:00', '2026-11-01T06:30:00+00:00'),
])
def test_quiet_delivery_uses_real_local_boundary(timezone, start, end, at, expected):
    item = TelegramIntegration(timezone=timezone, quiet_start=start, quiet_end=end)
    assert quiet_delivery_at(item, datetime.fromisoformat(at)) == datetime.fromisoformat(expected)


async def test_quiet_hours_defer_urgent_delivery_until_persisted_end(setup):
    await task_reminder(setup, due_at=AT, notify_at=AT - timedelta(minutes=1))
    async with setup.sessions() as session:
        item = await session.get(TelegramIntegration, 'integration')
        item.quiet_start = '09:00'; item.quiet_end = '17:00'
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    assert not setup.sent
    async with setup.sessions() as session:
        reminder = await session.get(TaskReminder, 'task-reminder')
        assert utc(reminder.notify_at) == AT.replace(hour=17)
        assert reminder.reminder_status == 'pending'
    await deliver_telegram_reminders('integration', at=AT.replace(hour=17))
    assert len(setup.sent) == 1


async def test_deadline_opt_in_offsets_catch_up_and_due_change(setup):
    async with setup.sessions() as session:
        session.add(Task(id='deadline', owner_id='owner', title='Private deadline', due_at=AT + timedelta(hours=5), updated_at=AT))
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    assert not setup.sent
    async with setup.sessions() as session:
        assert not list((await session.execute(select(TaskReminder))).scalars())
        item = await session.get(TelegramIntegration, 'integration')
        item.deadline_reminders = True
        await session.commit()
    await asyncio.gather(deliver_telegram_reminders('integration', at=AT), deliver_telegram_reminders('integration', at=AT))
    assert len(setup.sent) == 1
    # Simulate downtime beyond the second offset, then a restart/replay.
    late = AT + timedelta(hours=6)
    await deliver_telegram_reminders('integration', at=late)
    await deliver_telegram_reminders('integration', at=late)
    assert len(setup.sent) == 2
    async with setup.sessions() as session:
        rows = list((await session.execute(select(TaskReminder))).scalars())
        assert len(rows) == 2 and len({row.idempotency_key for row in rows}) == 2
        task = await session.get(Task, 'deadline')
        task.due_at = late + timedelta(hours=5)
        task.updated_at = late
        await session.commit()
    await deliver_telegram_reminders('integration', at=late)
    assert len(setup.sent) == 3


async def test_deadline_offset_already_past_at_task_update_is_not_sent(setup):
    async with setup.sessions() as session:
        integration = await session.get(TelegramIntegration, 'integration')
        integration.deadline_reminders = True
        session.add(Task(id='soon', owner_id='owner', title='Private soon deadline',
                         due_at=AT + timedelta(hours=1, minutes=40), updated_at=AT))
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    assert not setup.sent
    async with setup.sessions() as session:
        rows = list((await session.execute(select(TaskReminder))).scalars())
        assert [utc(row.notify_at) for row in rows] == [AT + timedelta(hours=1, minutes=30)]
    await deliver_telegram_reminders('integration', at=AT + timedelta(hours=1, minutes=30))
    assert len(setup.sent) == 1


async def test_deadline_offsets_seeded_when_task_set_well_before_due(setup):
    due = AT + timedelta(days=2)
    async with setup.sessions() as session:
        integration = await session.get(TelegramIntegration, 'integration')
        integration.deadline_reminders = True
        session.add(Task(id='early', owner_id='owner', title='Private early deadline',
                         due_at=due, updated_at=AT - timedelta(days=1)))
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    assert not setup.sent
    async with setup.sessions() as session:
        rows = list((await session.execute(select(TaskReminder))).scalars())
        assert sorted(utc(row.notify_at) for row in rows) == [due - timedelta(hours=5), due - timedelta(minutes=10)]


async def test_calendar_recurrence_claims_occurrence_once_across_dst(setup):
    first = datetime(2026, 10, 31, 13, tzinfo=UTC)  # 09:00 New York before fall-back
    async with setup.sessions() as session:
        session.add(CalendarEvent(id='event', owner_id='owner', title='Private event',
            starts_at=first, ends_at=first + timedelta(hours=1), timezone='America/New_York', rrule='FREQ=DAILY;COUNT=2'))
        session.add(CalendarReminder(id='calendar-reminder', owner_id='owner', event_id='event',
            notify_at=first - timedelta(minutes=10), occurrence_at=first, offset_seconds=600,
            channel='telegram', idempotency_key='calendar-schedule'))
        await session.commit()
    await deliver_telegram_reminders('integration', at=first)
    await deliver_telegram_reminders('integration', at=first)
    assert len(setup.sent) == 1
    async with setup.sessions() as session:
        row = await session.get(CalendarReminder, 'calendar-reminder')
        assert utc(row.occurrence_at) == datetime(2026, 11, 1, 14, tzinfo=UTC)
        assert utc(row.notify_at) == datetime(2026, 11, 1, 13, 50, tzinfo=UTC)
    await deliver_telegram_reminders('integration', at=datetime(2026, 11, 1, 13, 50, tzinfo=UTC))
    await deliver_telegram_reminders('integration', at=datetime(2026, 11, 1, 13, 50, tzinfo=UTC))
    assert len(setup.sent) == 2
    async with setup.sessions() as session:
        assert (await session.get(CalendarReminder, 'calendar-reminder')).reminder_status == 'delivered'
        notices = list((await session.execute(select(Notification))).scalars())
        assert len(notices) == 2 and len({row.dedup_key for row in notices}) == 2


async def test_calendar_quiet_deferral_keeps_original_implicit_offset(setup):
    first = AT.replace(hour=13)
    async with setup.sessions() as session:
        integration = await session.get(TelegramIntegration, 'integration')
        integration.quiet_start = '09:00'; integration.quiet_end = '17:00'
        session.add(CalendarEvent(id='quiet-event', owner_id='owner', title='Private quiet event',
            starts_at=first, ends_at=first + timedelta(hours=1), timezone='UTC', rrule='FREQ=DAILY;COUNT=2'))
        session.add(CalendarReminder(id='quiet-calendar', owner_id='owner', event_id='quiet-event',
            notify_at=AT, channel='telegram', idempotency_key='implicit-offset'))
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    assert not setup.sent
    async with setup.sessions() as session:
        reminder = await session.get(CalendarReminder, 'quiet-calendar')
        assert reminder.offset_seconds == 3600
        assert utc(reminder.occurrence_at) == first
        assert utc(reminder.notify_at) == AT.replace(hour=17)
    await deliver_telegram_reminders('integration', at=AT.replace(hour=17))
    assert len(setup.sent) == 1
    async with setup.sessions() as session:
        reminder = await session.get(CalendarReminder, 'quiet-calendar')
        assert utc(reminder.occurrence_at) == first + timedelta(days=1)
        assert utc(reminder.notify_at) == AT + timedelta(days=1)
        assert reminder.offset_seconds == 3600


@pytest.mark.parametrize('field,value', [('enabled', False), ('owner_telegram_id', None), ('encrypted_token', None)])
async def test_disabled_unbound_or_disconnected_integration_does_not_claim(setup, field, value):
    await task_reminder(setup)
    async with setup.sessions() as session:
        integration = await session.get(TelegramIntegration, 'integration')
        setattr(integration, field, value)
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    assert not setup.sent
    async with setup.sessions() as session:
        assert (await session.get(TaskReminder, 'task-reminder')).reminder_status == 'pending'
        assert not list((await session.execute(select(Notification))).scalars())


async def test_one_transport_failure_does_not_interrupt_other_reminders(setup):
    await task_reminder(setup, name='first')
    await task_reminder(setup, name='second')
    setup.failing()
    await deliver_telegram_reminders('integration', at=AT)
    assert len(setup.sent) == 2
    async with setup.sessions() as session:
        assert len(list((await session.execute(select(Notification))).scalars())) == 2


async def test_deleted_calendar_and_foreign_reference_cancel_during_quiet(setup):
    async with setup.sessions() as session:
        integration = await session.get(TelegramIntegration, 'integration')
        integration.quiet_start = '09:00'; integration.quiet_end = '17:00'
        for owner, name, deleted in [('owner', 'deleted', AT), ('other', 'foreign', None)]:
            session.add(CalendarEvent(id=name, owner_id=owner, title='Private ' + name,
                starts_at=AT, ends_at=AT + timedelta(hours=1), deleted_at=deleted))
            session.add(CalendarReminder(id=name + '-reminder', owner_id='owner', event_id=name,
                notify_at=AT, channel='telegram', idempotency_key=name + '-calendar'))
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    assert not setup.sent
    async with setup.sessions() as session:
        rows = list((await session.execute(select(CalendarReminder))).scalars())
        assert len(rows) == 2 and all(row.reminder_status == 'cancelled' for row in rows)


async def test_due_change_and_opt_out_cancel_old_seeded_schedules(setup):
    async with setup.sessions() as session:
        integration = await session.get(TelegramIntegration, 'integration')
        integration.deadline_reminders = True
        session.add(Task(id='rescheduled', owner_id='owner', title='Private rescheduled',
                         due_at=AT + timedelta(hours=6), updated_at=AT))
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT)
    assert not setup.sent
    async with setup.sessions() as session:
        task = await session.get(Task, 'rescheduled')
        task.due_at = AT + timedelta(days=1)
        task.updated_at = AT + timedelta(hours=1)
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT + timedelta(hours=1))
    assert not setup.sent
    async with setup.sessions() as session:
        rows = list((await session.execute(select(TaskReminder))).scalars())
        assert len(rows) == 4
        assert sum(row.reminder_status == 'cancelled' for row in rows) == 1
        integration = await session.get(TelegramIntegration, 'integration')
        integration.deadline_reminders = False
        await session.commit()
    await deliver_telegram_reminders('integration', at=AT + timedelta(days=2))
    assert not setup.sent
    async with setup.sessions() as session:
        assert all(row.reminder_status == 'cancelled' for row in (await session.execute(select(TaskReminder))).scalars())
