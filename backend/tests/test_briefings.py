"""Agenda local days/DST/recurrence and at-most-once digest."""
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from app.core.models import CalendarEvent, Task, User
from app.domains.briefings import build_agenda, format_agenda
from app.integrations import telegram_service as service
from app.integrations.telegram_models import TelegramIntegration
from sqlalchemy import select
from test_telegram_business import connect, set_bound

pytest_plugins = ("test_telegram_business",)


@pytest.mark.parametrize('at,zone', [
    (datetime(2026, 11, 1, 0, 30, tzinfo=UTC), 'America/New_York'),
    (datetime(2026, 3, 8, 16, tzinfo=UTC), 'America/New_York'),
    (datetime(2026, 11, 1, 20, tzinfo=UTC), 'Asia/Almaty'),
])
async def test_agenda_day_bounds_completed_deleted_and_rrule(setup, at, zone):
    _, sessions, _ = setup
    tz = ZoneInfo(zone)
    local = at.astimezone(tz)
    start = local.replace(hour=0, minute=0, second=0).astimezone(UTC)
    end = (local.replace(hour=0, minute=0, second=0) + timedelta(days=1)).astimezone(UTC)
    async with sessions() as db:
        owner = (await db.execute(select(User))).scalar_one().id
        db.add_all([
            Task(owner_id=owner, title='today-item', due_at=start),
            Task(owner_id=owner, title='overdue-item', due_at=start-timedelta(seconds=1)),
            Task(owner_id=owner, title='tomorrow-item', due_at=end),
            Task(owner_id=owner, title='done-item', status='done', due_at=start),
            Task(owner_id=owner, title='cancelled-item', status='cancelled', due_at=start),
            Task(owner_id=owner, title='deleted-item', deleted_at=at, due_at=start),
            CalendarEvent(owner_id=owner, title='recurring-event', starts_at=start-timedelta(days=7)+timedelta(hours=12),
                          ends_at=start-timedelta(days=7)+timedelta(hours=13), timezone=zone, rrule='FREQ=DAILY;COUNT=30'),
            CalendarEvent(owner_id=owner, title='deleted-event', starts_at=start, ends_at=end, deleted_at=at),
        ])
        await db.commit()
        text = format_agenda(await build_agenda(db, owner, tz, at))
        assert local.date().isoformat() in text and zone in text
        for expected in ['today-item', 'overdue-item', 'recurring-event']:
            assert expected in text
        for excluded in ['tomorrow-item', 'done-item', 'cancelled-item', 'deleted-item', 'deleted-event']:
            assert excluded not in text


async def test_digest_once_persisted_window_disabled_and_failure(setup):
    client, sessions, fake = setup
    data = await connect(client)
    await set_bound(sessions, data['id'])
    at = datetime(2026, 11, 1, 16, tzinfo=UTC)
    async with sessions() as db:
        item = await db.get(TelegramIntegration, data['id'])
        item.timezone = 'Asia/Almaty'
        await db.commit()
    await service.digest_once(data['id'], at=at)
    assert not fake.sent
    async with sessions() as db:
        item = await db.get(TelegramIntegration, data['id'])
        item.digest_time = '20:00'
        await db.commit()
    await service.digest_once(data['id'], at=at)
    await service.digest_once(data['id'], at=at+timedelta(minutes=20))
    assert len(fake.sent) == 1
    await service.digest_once(data['id'], at=at+timedelta(days=1, hours=2))
    assert len(fake.sent) == 1  # no catch-up beyond the two-hour window


async def test_digest_claim_survives_failed_delivery_and_concurrent_workers(setup):
    import asyncio

    from app.integrations.telegram_transport import TelegramError
    client, sessions, fake = setup
    item = await connect(client)
    await set_bound(sessions, item['id'])
    async with sessions() as db:
        integration = await db.get(TelegramIntegration, item['id'])
        integration.digest_time = '20:00'
        await db.commit()
    fake.send_error = TelegramError('timeout')
    at = datetime(2026, 11, 1, 20, 30, tzinfo=UTC)
    await asyncio.gather(service.digest_once(item['id'], at=at), service.digest_once(item['id'], at=at))
    await service.digest_once(item['id'], at=at)
    assert len(fake.sent) == 1
    async with sessions() as db:
        assert (await db.get(TelegramIntegration, item['id'])).last_digest_on == at.date()
