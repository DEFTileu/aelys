"""Read-only provider HTTP with real local transactions, leases and sync logs."""
import asyncio
import copy
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from app.ai.crypto import decrypt_secret, encrypt_secret
from app.core import db as database
from app.core.db import Base
from app.core.models import (
    AuthSession,
    CalendarEvent,
    HistoryEntry,
    SyncChange,
    SyncRecord,
    User,
)
from app.domains import google_calendar_sync as sync
from app.domains.google_calendar_models import (
    GoogleCalendarConnection,
    GoogleCalendarCredential,
    GoogleCalendarOAuthState,
)
from app.domains.google_calendar_projection import project_google_calendar_events
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

AT = datetime(2026, 11, 1, 12, tzinfo=UTC)


def remote(event_id='remote-1', **values):
    return {'id': event_id, 'summary': 'Remote meeting',
        'start': {'dateTime': '2026-11-02T09:00:00-05:00', 'timeZone': 'America/New_York'},
        'end': {'dateTime': '2026-11-02T10:00:00-05:00', 'timeZone': 'America/New_York'}, **values}


@pytest.fixture
async def calendar_sync_setup(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/calendar.db')
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(database, 'SessionLocal', sessions)
    async with sessions() as db:
        db.add_all([User(id='owner'), User(id='other')])
        for connection_id, owner in [('connection', 'owner'), ('other-connection', 'other')]:
            db.add(GoogleCalendarConnection(id=connection_id, owner_id=owner,
                calendar_id='primary', calendar_timezone='America/New_York', connection_status='connected'))
            db.add(GoogleCalendarCredential(connection_id=connection_id, encrypted_tokens=encrypt_secret(json.dumps({
                'access_token': 'calendar-access', 'refresh_token': 'calendar-refresh', 'expires_at': 4102444800,
                'scope': 'https://www.googleapis.com/auth/calendar.readonly'}))))
        await db.commit()
    calls = []
    pages = [{'items': [remote()], 'nextSyncToken': 'cursor-1', 'timeZone': 'America/New_York'}]
    async def request(method, url, **kwargs):
        calls.append((method, url, copy.deepcopy(kwargs)))
        page = pages.pop(0)
        if isinstance(page, Exception):
            raise page
        return copy.deepcopy(page)
    monkeypatch.setattr(sync, 'google_calendar_request', request)
    try:
        yield SimpleNamespace(sessions=sessions, calls=calls, pages=pages, request=request)
    finally:
        await engine.dispose()


async def rows(calendar_sync_setup):
    async with calendar_sync_setup.sessions() as db:
        return list((await db.execute(select(CalendarEvent).order_by(CalendarEvent.external_id))).scalars())


async def test_full_then_incremental_repeat_is_idempotent_encrypted_and_shared_sync(calendar_sync_setup):
    assert await sync.sync_google_calendar('connection', owner_id='owner', at=AT) == {'imported': 1, 'deleted': 0, 'full_sync': True}
    initial = (await rows(calendar_sync_setup))[0]
    calendar_sync_setup.pages.extend([{'items': [remote()], 'nextSyncToken': 'cursor-2'}])
    assert await sync.sync_google_calendar('connection', at=AT + timedelta(minutes=1)) == {'imported': 0, 'deleted': 0, 'full_sync': False}
    assert len(await rows(calendar_sync_setup)) == 1 and (await rows(calendar_sync_setup))[0].version == initial.version == 1
    method, url, kwargs = calendar_sync_setup.calls[-1]
    assert method == 'GET' and url == 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
    assert kwargs['params'] == {'singleEvents': 'false', 'showDeleted': 'true', 'maxResults': 2500, 'syncToken': 'cursor-1'}
    async with calendar_sync_setup.sessions() as db:
        conn = await db.get(GoogleCalendarConnection, 'connection')
        assert decrypt_secret(conn.encrypted_sync_token) == 'cursor-2'
        raw = (await db.execute(text('SELECT encrypted_sync_token FROM google_calendar_connections WHERE id=:id'), {'id': conn.id})).scalar_one()
        assert 'cursor-2' not in raw
        changes = list((await db.execute(select(SyncChange))).scalars())
        assert len(changes) == 1 and changes[0].version == 1
        assert changes[0].payload['external_source'] == 'google_calendar:connection'
        assert list((await db.execute(select(HistoryEntry))).scalars()) == []
        assert (await db.get(SyncRecord, ('owner', 'event', initial.id))).version == initial.version


async def test_all_pages_validate_before_apply_and_previous_token_survives_invalid_page(calendar_sync_setup):
    async with calendar_sync_setup.sessions() as db:
        conn = await db.get(GoogleCalendarConnection, 'connection')
        conn.encrypted_sync_token = encrypt_secret('previous'); conn.last_synced_at = AT
        await db.commit()
    invalid = remote('invalid'); invalid.pop('end')
    calendar_sync_setup.pages[:] = [{'items': [remote()], 'nextPageToken': 'page-2'}, {'items': [invalid], 'nextSyncToken': 'must-not-commit'}]
    with pytest.raises(HTTPException) as error:
        await sync.sync_google_calendar('connection', at=AT + timedelta(minutes=15))
    assert error.value.detail['code'] == 'CALENDAR_INVALID_DATA'
    assert await rows(calendar_sync_setup) == []
    async with calendar_sync_setup.sessions() as db:
        conn = await db.get(GoogleCalendarConnection, 'connection')
        assert decrypt_secret(conn.encrypted_sync_token) == 'previous'
        assert conn.last_error_code == 'CALENDAR_INVALID_DATA'
        assert list((await db.execute(select(SyncChange))).scalars()) == []
    assert calendar_sync_setup.calls[-1][2]['params']['pageToken'] == 'page-2'


async def test_identical_legacy_import_without_sync_mirror_is_indexed_without_version_change(calendar_sync_setup):
    async with calendar_sync_setup.sessions() as db:
        db.add(CalendarEvent(id='legacy-import', owner_id='owner', title='Remote meeting', description='',
            starts_at=datetime(2026, 11, 2, 14, tzinfo=UTC), ends_at=datetime(2026, 11, 2, 15, tzinfo=UTC),
            timezone='America/New_York', all_day=False, rrule=None, version=4,
            external_source='google_calendar:connection', external_id='remote-1', external_metadata={}))
        await db.commit()
    result = await sync.sync_google_calendar('connection', at=AT)
    assert result['imported'] == result['deleted'] == 0
    async with calendar_sync_setup.sessions() as db:
        assert (await db.get(CalendarEvent, 'legacy-import')).version == 4
        mirror = await db.get(SyncRecord, ('owner', 'event', 'legacy-import'))
        assert mirror is not None and mirror.version == 4
        changes = list((await db.execute(select(SyncChange))).scalars())
        assert len(changes) == 1 and changes[0].version == 4
        assert list((await db.execute(select(HistoryEntry))).scalars()) == []


async def test_expired_token_restarts_full_fetch_and_reconciles_only_imported_rows(calendar_sync_setup):
    await sync.sync_google_calendar('connection', at=AT)
    async with calendar_sync_setup.sessions() as db:
        db.add(CalendarEvent(id='local', owner_id='owner', title='Local preserved', starts_at=AT,
            ends_at=AT + timedelta(hours=1), timezone='UTC'))
        await db.commit()
    calendar_sync_setup.pages[:] = [{'items': [remote('discard-incremental')], 'nextPageToken': 'expired-page'},
        HTTPException(410, detail={'code': 'CALENDAR_SYNC_EXPIRED'}),
        {'items': [remote('full-first')], 'nextPageToken': 'full-page'},
        {'items': [remote('full-second')], 'nextSyncToken': 'full-cursor'}]
    result = await sync.sync_google_calendar('connection', at=AT + timedelta(minutes=15))
    assert result == {'imported': 2, 'deleted': 1, 'full_sync': True}
    imported = {row.external_id: row for row in await rows(calendar_sync_setup) if row.external_source}
    assert set(imported) == {'remote-1', 'full-first', 'full-second'}
    assert imported['remote-1'].deleted_at and imported['remote-1'].version == 2
    assert not next(row for row in await rows(calendar_sync_setup) if row.id == 'local').deleted_at
    assert 'syncToken' not in calendar_sync_setup.calls[-2][2]['params']


async def test_cancelled_exception_and_master_tombstones_survive_projection(calendar_sync_setup):
    master = remote('master', recurrence=['RRULE:FREQ=DAILY;COUNT=3'])
    cancellation = {'id': 'exception', 'status': 'cancelled', 'recurringEventId': 'master',
        'originalStartTime': {'dateTime': '2026-11-03T09:00:00-05:00'}}
    calendar_sync_setup.pages[:] = [{'items': [master, cancellation], 'nextSyncToken': 'first'}]
    await sync.sync_google_calendar('connection', at=AT)
    events = await rows(calendar_sync_setup)
    placeholder = next(row for row in events if row.external_id == 'exception')
    assert placeholder.deleted_at and placeholder.title == '(Cancelled)'
    assert placeholder.ends_at - placeholder.starts_at == timedelta(seconds=1)
    assert placeholder.external_metadata['original_start'] == '2026-11-03T14:00:00+00:00'
    values = project_google_calendar_events(events, AT, AT + timedelta(days=5))
    assert len(values) == 2
    calendar_sync_setup.pages[:] = [{'items': [{'id': 'master', 'status': 'cancelled'}], 'nextSyncToken': 'second'}]
    await sync.sync_google_calendar('connection', at=AT + timedelta(minutes=15))
    assert all(row.deleted_at for row in await rows(calendar_sync_setup))
    assert project_google_calendar_events(await rows(calendar_sync_setup), AT, AT + timedelta(days=5)) == []


async def test_parallel_lease_is_committed_before_network_and_foreign_owner_denied(calendar_sync_setup, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    async def request(*args, **kwargs):
        entered.set(); await release.wait()
        return {'items': [remote()], 'nextSyncToken': 'done'}
    monkeypatch.setattr(sync, 'google_calendar_request', request)
    task = asyncio.create_task(sync.sync_google_calendar('connection', at=AT))
    try:
        await asyncio.wait_for(entered.wait(), 3)
        async with calendar_sync_setup.sessions() as observer:
            conn = await observer.get(GoogleCalendarConnection, 'connection')
            assert conn.lease_owner and conn.last_attempt_at
        with pytest.raises(HTTPException) as busy:
            await sync.sync_google_calendar('connection', at=AT)
        assert busy.value.detail['code'] == 'CALENDAR_SYNC_BUSY'
        with pytest.raises(HTTPException) as foreign:
            await sync.sync_google_calendar('connection', owner_id='other', at=AT)
        assert foreign.value.status_code == 404
    finally:
        release.set(); await task
    assert len(await rows(calendar_sync_setup)) == 1


async def test_disconnect_flush_only_clears_credentials_and_prevents_stale_inflight_apply(calendar_sync_setup, monkeypatch):
    await sync.sync_google_calendar('connection', at=AT)
    async def request(*args, **kwargs):
        async with calendar_sync_setup.sessions() as db:
            conn = await db.get(GoogleCalendarConnection, 'connection')
            await sync.disconnect_google_calendar(db, conn)
            async with calendar_sync_setup.sessions() as observer:
                assert (await observer.get(GoogleCalendarConnection, conn.id)).connection_status == 'connected'
            await db.commit()
        return {'items': [remote('stale-response')], 'nextSyncToken': 'stale-secret'}
    monkeypatch.setattr(sync, 'google_calendar_request', request)
    with pytest.raises(HTTPException):
        await sync.sync_google_calendar('connection', at=AT + timedelta(minutes=15))
    imported = await rows(calendar_sync_setup)
    assert len(imported) == 1 and imported[0].deleted_at and imported[0].version == 2
    async with calendar_sync_setup.sessions() as db:
        conn = await db.get(GoogleCalendarConnection, 'connection')
        assert conn.connection_status == 'disconnected' and conn.encrypted_sync_token is None
        assert await db.get(GoogleCalendarCredential, conn.id) is None
        changes = list((await db.execute(select(SyncChange).order_by(SyncChange.seq))).scalars())
        assert [row.version for row in changes] == [1, 2] and changes[-1].operation == 'delete'


async def test_worker_isolates_revoked_token_and_honors_fifteen_minute_attempts(calendar_sync_setup):
    calendar_sync_setup.pages[:] = [HTTPException(409, detail={'code': 'CALENDAR_RECONNECT_REQUIRED'}),
        {'items': [remote('other-event')], 'nextSyncToken': 'other-cursor'}]
    await sync.sync_due_google_calendars(at=AT)
    assert len(calendar_sync_setup.calls) == 2
    async with calendar_sync_setup.sessions() as db:
        failed = await db.get(GoogleCalendarConnection, 'connection')
        healthy = await db.get(GoogleCalendarConnection, 'other-connection')
        assert failed.last_error_code == 'CALENDAR_RECONNECT_REQUIRED' and failed.connection_status == 'error'
        assert healthy.connection_status == 'connected' and healthy.last_synced_at
    await sync.sync_due_google_calendars(at=AT + timedelta(minutes=14, seconds=59))
    assert len(calendar_sync_setup.calls) == 2
    calendar_sync_setup.pages[:] = [{'items': [], 'nextSyncToken': 'new-other'}]
    await sync.sync_due_google_calendars(at=AT + timedelta(minutes=15))
    assert len(calendar_sync_setup.calls) == 3


async def test_transient_failure_retries_on_next_fifteen_minute_worker_tick(calendar_sync_setup):
    async with calendar_sync_setup.sessions() as db:
        (await db.get(GoogleCalendarConnection, 'other-connection')).connection_status = 'disconnected'
        await db.commit()
    calendar_sync_setup.pages[:] = [HTTPException(503, detail={'code': 'CALENDAR_UNAVAILABLE'})]
    await sync.sync_due_google_calendars(at=AT)
    async with calendar_sync_setup.sessions() as db:
        conn = await db.get(GoogleCalendarConnection, 'connection')
        assert conn.connection_status == 'connected' and conn.last_error_code == 'CALENDAR_UNAVAILABLE'
    await sync.sync_due_google_calendars(at=AT + timedelta(minutes=14, seconds=59))
    assert len(calendar_sync_setup.calls) == 1
    calendar_sync_setup.pages[:] = [{'items': [remote()], 'nextSyncToken': 'retried'}]
    await sync.sync_due_google_calendars(at=AT + timedelta(minutes=15))
    assert len(calendar_sync_setup.calls) == 2 and len(await rows(calendar_sync_setup)) == 1


@pytest.mark.parametrize('cancelled', [False, True])
async def test_full_rebuild_removes_obsolete_exception_suppression(calendar_sync_setup, cancelled):
    master = remote('master', recurrence=['RRULE:FREQ=DAILY;COUNT=3'])
    exception = remote('exception', recurringEventId='master',
        originalStartTime={'dateTime': '2026-11-03T09:00:00-05:00'},
        start={'dateTime': '2026-11-03T12:00:00-05:00'}, end={'dateTime': '2026-11-03T13:00:00-05:00'},
        status='cancelled' if cancelled else 'confirmed')
    calendar_sync_setup.pages[:] = [{'items': [master, exception], 'nextSyncToken': 'original'}]
    await sync.sync_google_calendar('connection', at=AT)
    calendar_sync_setup.pages[:] = [HTTPException(410, detail={'code': 'CALENDAR_SYNC_EXPIRED'}),
        {'items': [master], 'nextSyncToken': 'full-again'}]
    await sync.sync_google_calendar('connection', at=AT + timedelta(minutes=15))
    events = await rows(calendar_sync_setup)
    old_exception = next(event for event in events if event.external_id == 'exception')
    assert old_exception.deleted_at and 'recurring_event_id' not in old_exception.external_metadata
    values = project_google_calendar_events(events, AT, AT + timedelta(days=5))
    assert [start.isoformat() for _, start, _ in values] == [
        '2026-11-02T14:00:00+00:00', '2026-11-03T14:00:00+00:00', '2026-11-04T14:00:00+00:00']
    assert old_exception.version == 2


async def test_network_deadline_preserves_cursor_events_and_allows_retry(calendar_sync_setup, monkeypatch):
    await sync.sync_google_calendar('connection', at=AT)
    async def hanging_request(*args, **kwargs):
        await asyncio.Event().wait()
    monkeypatch.setattr(sync, 'google_calendar_request', hanging_request)
    monkeypatch.setattr(sync, 'NETWORK_TIMEOUT_SECONDS', .02, raising=False)
    with pytest.raises(HTTPException) as error:
        await asyncio.wait_for(sync.sync_google_calendar('connection', at=AT + timedelta(minutes=15)), 1)
    assert error.value.detail['code'] == 'CALENDAR_UNAVAILABLE'
    async with calendar_sync_setup.sessions() as db:
        conn = await db.get(GoogleCalendarConnection, 'connection')
        assert conn.connection_status == 'connected' and conn.lease_owner is None
        assert decrypt_secret(conn.encrypted_sync_token) == 'cursor-1'
        assert [event.version for event in await rows(calendar_sync_setup)] == [1]


async def test_disconnect_invalidates_only_owner_pending_oauth_states(calendar_sync_setup):
    async with calendar_sync_setup.sessions() as db:
        db.add_all([AuthSession(id='owner-session', owner_id='owner', refresh_token_hash='owner-hash',
            expires_at=AT + timedelta(days=1)), AuthSession(id='other-session', owner_id='other',
            refresh_token_hash='other-hash', expires_at=AT + timedelta(days=1))])
        await db.flush()
        db.add_all([GoogleCalendarOAuthState(state_hash='owner-state', owner_id='owner', session_id='owner-session',
            encrypted_verifier=encrypt_secret('owner-verifier'), expires_at=AT + timedelta(minutes=5)),
            GoogleCalendarOAuthState(state_hash='other-state', owner_id='other', session_id='other-session',
            encrypted_verifier=encrypt_secret('other-verifier'), expires_at=AT + timedelta(minutes=5))])
        await db.commit()
        await sync.disconnect_google_calendar(db, await db.get(GoogleCalendarConnection, 'connection'))
        await db.commit()
        assert await db.get(GoogleCalendarOAuthState, 'owner-state') is None
        assert await db.get(GoogleCalendarOAuthState, 'other-state') is not None


@pytest.mark.parametrize('bound', ['pages', 'items'])
async def test_fetch_bounds_preserve_cursor_and_have_no_partial_domain_writes(calendar_sync_setup, monkeypatch, bound):
    if bound == 'pages':
        monkeypatch.setattr(sync, 'MAX_PAGES', 1)
        calendar_sync_setup.pages[:] = [{'items': [remote()], 'nextPageToken': 'more'}]
    else:
        monkeypatch.setattr(sync, 'MAX_ITEMS', 1)
        calendar_sync_setup.pages[:] = [{'items': [remote(), remote('extra')], 'nextSyncToken': 'over-bound'}]
    with pytest.raises(HTTPException) as error:
        await sync.sync_google_calendar('connection', at=AT)
    assert error.value.detail['code'] == 'CALENDAR_SYNC_LIMIT'
    assert await rows(calendar_sync_setup) == []
