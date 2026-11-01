"""Imported recurrence reaches the mounted calendar router and Telegram /today."""
import json
from datetime import UTC, datetime, time, timedelta

from app.ai.crypto import encrypt_secret
from app.core.models import CalendarEvent, User
from app.domains import google_calendar_sync as calendar
from app.domains.google_calendar_models import (
    GoogleCalendarConnection,
    GoogleCalendarCredential,
)
from app.integrations import telegram_service
from app.integrations.telegram_models import TelegramIntegration
from sqlalchemy import select
from test_telegram_personal import bound, ordinary

pytest_plugins = ('test_telegram_business',)


async def import_through_router(client, sessions, integration_id, monkeypatch, items):
    async with sessions() as db:
        integration = await db.get(TelegramIntegration, integration_id)
        owner_id = integration.owner_id
        db.add(GoogleCalendarConnection(id='api-calendar', owner_id=owner_id,
            calendar_timezone='UTC', connection_status='connected'))
        db.add(GoogleCalendarCredential(connection_id='api-calendar', encrypted_tokens=encrypt_secret(json.dumps({
            'access_token': 'test-access', 'refresh_token': 'test-refresh', 'expires_at': 4102444800,
            'scope': 'https://www.googleapis.com/auth/calendar.readonly'}))))
        await db.commit()
    async def request(method, url, **kwargs):
        assert method == 'GET' and url.endswith('/calendars/primary/events')
        return {'items': items, 'nextSyncToken': 'api-cursor', 'timeZone': 'UTC'}
    monkeypatch.setattr(calendar, 'google_calendar_request', request)
    response = await client.post('/api/v1/calendar/google/sync')
    assert response.status_code == 200, response.text
    return owner_id


async def test_actual_router_projects_external_rrules_exdates_and_exceptions_once(setup, monkeypatch):
    client, sessions, _, integration_id = await bound(setup)
    master = {'id': 'series', 'summary': 'Original series',
        'start': {'dateTime': '2026-03-07T09:00:00-05:00', 'timeZone': 'America/New_York'},
        'end': {'dateTime': '2026-03-07T10:00:00-05:00', 'timeZone': 'America/New_York'},
        'recurrence': ['RRULE:FREQ=DAILY;COUNT=4;BYHOUR=9',
            'EXDATE;TZID=America/New_York:20260308T090000', 'RDATE;TZID=America/New_York:20260312T090000']}
    moved = {'id': 'moved', 'summary': 'Moved instance', 'recurringEventId': 'series',
        'originalStartTime': {'dateTime': '2026-03-09T09:00:00-04:00'},
        'start': {'dateTime': '2026-03-09T12:00:00-04:00'}, 'end': {'dateTime': '2026-03-09T13:00:00-04:00'}}
    cancelled = {'id': 'cancelled', 'status': 'cancelled', 'recurringEventId': 'series',
        'originalStartTime': {'dateTime': '2026-03-10T09:00:00-04:00'}}
    await import_through_router(client, sessions, integration_id, monkeypatch, [master, moved, cancelled])
    response = await client.get('/api/v1/calendar/occurrences', params={
        'starts_at': '2026-03-07T00:00:00Z', 'ends_at': '2026-03-14T00:00:00Z'})
    assert response.status_code == 200, response.text
    projected = response.json()
    assert [(row['title'], datetime.fromisoformat(row['starts_at'])) for row in projected] == [
        ('Original series', datetime(2026, 3, 7, 14, tzinfo=UTC)),
        ('Moved instance', datetime(2026, 3, 9, 16, tzinfo=UTC)),
        ('Original series', datetime(2026, 3, 12, 13, tzinfo=UTC))]
    assert len({row['occurrence_id'] for row in projected}) == 3
    series = await client.get('/api/v1/calendar/events')
    assert series.status_code == 200, series.text
    assert {row['external_id'] for row in series.json()} == {'series', 'moved'}
    assert all(row['external_source'] == 'google_calendar:api-calendar' for row in projected)
    assert all('external_metadata' not in row for row in projected)


async def test_real_owner_today_uses_imported_projection_without_cloning_series(setup, monkeypatch):
    client, sessions, fake, integration_id = await bound(setup)
    today = datetime.combine(datetime.now(UTC).date(), time.min, UTC)
    yesterday, tomorrow = today - timedelta(days=1), today + timedelta(days=1)
    master = {'id': 'daily', 'summary': 'Suppressed master',
        'start': {'dateTime': (yesterday + timedelta(hours=9)).isoformat()},
        'end': {'dateTime': (yesterday + timedelta(hours=10)).isoformat()},
        'recurrence': ['RRULE:FREQ=DAILY;COUNT=3']}
    moved = {'id': 'today-moved', 'summary': 'Imported today at noon', 'recurringEventId': 'daily',
        'originalStartTime': {'dateTime': (today + timedelta(hours=9)).isoformat()},
        'start': {'dateTime': (today + timedelta(hours=12)).isoformat()},
        'end': {'dateTime': (today + timedelta(hours=13)).isoformat()}}
    cancelled = {'id': 'tomorrow-cancelled', 'status': 'cancelled', 'recurringEventId': 'daily',
        'originalStartTime': {'dateTime': (tomorrow + timedelta(hours=9)).isoformat()}}
    await import_through_router(client, sessions, integration_id, monkeypatch, [master, moved, cancelled])
    local = await client.post('/api/v1/calendar/events', json={'title': 'Local today',
        'starts_at': (today + timedelta(hours=10)).isoformat(), 'ends_at': (today + timedelta(hours=11)).isoformat()})
    assert local.status_code == 200, local.text
    async with sessions() as db:
        integration = await db.get(TelegramIntegration, integration_id)
        integration.timezone = 'UTC'
        db.add(User(id='foreign-calendar-owner'))
        db.add(CalendarEvent(owner_id='foreign-calendar-owner', title='Foreign calendar secret',
            starts_at=today + timedelta(hours=12), ends_at=today + timedelta(hours=13), timezone='UTC'))
        await db.commit()
        before = len(list((await db.execute(select(CalendarEvent))).scalars()))
    fake.updates = [ordinary(500, '/today')]
    await telegram_service.poll_once(integration_id, timeout=0)
    text = fake.sent[-1][1]
    assert today.date().isoformat() in text and '12:00 Imported today at noon' in text
    assert text.count('Imported today at noon') == 1 and '10:00 Local today' in text
    assert 'Suppressed master' not in text and 'Foreign calendar secret' not in text and '(Cancelled)' not in text
    async with sessions() as db:
        assert len(list((await db.execute(select(CalendarEvent))).scalars())) == before


async def test_actual_router_imports_exrule_and_omits_excluded_weekday(setup, monkeypatch):
    client, sessions, _, integration_id = await bound(setup)
    master = {'id': 'exrule-api', 'summary': 'Monday and Wednesday',
        'start': {'dateTime': '2026-11-02T09:00:00Z'}, 'end': {'dateTime': '2026-11-02T10:00:00Z'},
        'recurrence': ['RRULE:FREQ=DAILY;COUNT=3', 'EXRULE:FREQ=WEEKLY;BYDAY=TU']}
    await import_through_router(client, sessions, integration_id, monkeypatch, [master])
    response = await client.get('/api/v1/calendar/occurrences', params={
        'starts_at': '2026-11-02T00:00:00Z', 'ends_at': '2026-11-05T00:00:00Z'})
    assert response.status_code == 200, response.text
    assert [datetime.fromisoformat(row['starts_at']).day for row in response.json()] == [2, 4]
