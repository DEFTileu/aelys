"""Read-only Calendar consent, encrypted credentials and bounded Google I/O."""
import hashlib
import json
import logging
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from app.ai.crypto import decrypt_secret, encrypt_secret
from app.ai.errors import PolicyDenied
from app.ai.policy import ServerPolicyEngine
from app.core.api import router as core_router
from app.core.config import get_settings
from app.core.db import Base, get_db
from app.core.models import AuthSession, GmailOAuthState
from app.domains import google_calendar_oauth as calendar
from app.domains.gmail import router as gmail_router
from app.domains.google_calendar_models import (
    GoogleCalendarConnection,
    GoogleCalendarCredential,
    GoogleCalendarOAuthState,
)
from fastapi import FastAPI, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'


@pytest.fixture
async def calendar_client(tmp_path, monkeypatch):
    monkeypatch.setenv('AELYS_GMAIL_CLIENT_ID', 'calendar-client')
    monkeypatch.setenv('AELYS_GMAIL_CLIENT_SECRET', 'private-client-secret')
    monkeypatch.setenv('AELYS_CALENDAR_REDIRECT_URI', 'https://test/api/v1/calendar/google/callback')
    monkeypatch.setenv('AELYS_GMAIL_REDIRECT_URI', 'https://test/api/v1/mail/gmail/callback')
    get_settings.cache_clear()
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/calendar.db')
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async def database():
        async with sessions() as db:
            yield db
    app = FastAPI()
    app.include_router(core_router, prefix='/api/v1')
    app.include_router(calendar.router, prefix='/api/v1')
    app.include_router(gmail_router, prefix='/api/v1')
    app.dependency_overrides[get_db] = database
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://test') as client:
            owner = await client.post('/api/v1/auth/bootstrap', json={'email': 'calendar@example.test', 'password': 'calendar-test-password'})
            assert owner.status_code == 200, owner.text
            client.headers['Authorization'] = 'Bearer ' + owner.json()['access_token']
            yield SimpleNamespace(client=client, sessions=sessions)
    finally:
        await engine.dispose()
        get_settings.cache_clear()


async def begin(setup):
    response = await setup.client.post('/api/v1/calendar/google/connect')
    assert response.status_code == 200, response.text
    return parse_qs(urlparse(response.json()['authorization_url']).query), response


def google_stub(monkeypatch, *, scope=SCOPE, refresh='private-refresh-token'):
    calls = []
    async def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if url.endswith('/token'):
            return {'access_token': 'private-access-token', 'refresh_token': refresh, 'expires_in': 3600, 'scope': scope}
        assert method == 'GET' and url == 'https://www.googleapis.com/calendar/v3/calendars/primary'
        return {'id': 'primary@example.test', 'timeZone': 'America/New_York'}
    monkeypatch.setattr(calendar, 'google_calendar_request', request)
    return calls


async def finish(setup, query):
    return await setup.client.get('/api/v1/calendar/google/callback', params={'state': query['state'][0], 'code': 'private-code'})


async def test_calendar_consent_is_separate_read_only_pkce_and_encrypted(calendar_client, monkeypatch):
    setup = calendar_client
    calls = google_stub(monkeypatch)
    gmail = await setup.client.post('/api/v1/mail/gmail/connect')
    query, start = await begin(setup)
    assert query['scope'] == [SCOPE] and query['code_challenge_method'] == ['S256']
    assert query['redirect_uri'] == ['https://test/api/v1/calendar/google/callback']
    assert query.get('include_granted_scopes', ['false']) == ['false']
    assert 'HttpOnly' in start.headers['set-cookie'] and 'Path=/api/v1/calendar/google' in start.headers['set-cookie']
    assert 'private-client-secret' not in start.text
    state_hash = hashlib.sha256(query['state'][0].encode()).hexdigest()
    async with setup.sessions() as db:
        state = await db.get(GoogleCalendarOAuthState, state_hash)
        assert state.encrypted_verifier != decrypt_secret(state.encrypted_verifier)
    callback = await finish(setup, query)
    assert callback.status_code == 303, callback.text
    assert callback.headers['location'] == 'https://test/settings?section=calendar'
    assert (await finish(setup, query)).status_code == 400
    assert len(calls) == 2
    status = await setup.client.get('/api/v1/calendar/google/status')
    assert status.status_code == 200 and status.json()['configured'] is True
    data = status.json()['connection']
    assert data['status'] == 'connected' and data['calendar_id'] == 'primary@example.test'
    assert all(secret not in status.text + callback.text for secret in ['private-access-token', 'private-refresh-token', 'private-client-secret'])
    async with setup.sessions() as db:
        connection = await db.get(GoogleCalendarConnection, data['id'])
        assert connection.calendar_timezone == 'America/New_York'
        credential = await db.get(GoogleCalendarCredential, data['id'])
        assert 'private-refresh-token' not in credential.encrypted_tokens
        assert json.loads(decrypt_secret(credential.encrypted_tokens))['refresh_token'] == 'private-refresh-token'
        assert list((await db.execute(select(GoogleCalendarOAuthState))).scalars()) == []
        assert len(list((await db.execute(select(GmailOAuthState))).scalars())) == 1
    assert gmail.status_code == 200


@pytest.mark.parametrize('scope,refresh', [('', 'refresh'), ('https://www.googleapis.com/auth/calendar', 'refresh'),
    (SCOPE + ' https://www.googleapis.com/auth/gmail.readonly', 'refresh'), (SCOPE, None)])
async def test_invalid_grant_never_creates_connection(calendar_client, monkeypatch, scope, refresh):
    google_stub(monkeypatch, scope=scope, refresh=refresh)
    query, _ = await begin(calendar_client)
    response = await finish(calendar_client, query)
    assert response.status_code == 409 and response.json()['detail']['code'] == 'CALENDAR_SCOPE_REQUIRED'
    async with calendar_client.sessions() as db:
        assert list((await db.execute(select(GoogleCalendarConnection))).scalars()) == []


async def test_revoked_session_and_wrong_cookie_never_call_google(calendar_client, monkeypatch):
    calls = google_stub(monkeypatch)
    query, _ = await begin(calendar_client)
    calendar_client.client.cookies.clear()
    assert (await finish(calendar_client, query)).status_code == 400
    calendar_client.client.cookies.set(calendar.COOKIE, query['state'][0], path='/api/v1/calendar/google')
    async with calendar_client.sessions() as db:
        session = (await db.execute(select(AuthSession))).scalar_one()
        from app.core.models import now
        session.revoked_at = now(); await db.commit()
    response = await finish(calendar_client, query)
    assert response.status_code == 401 and calls == []


async def test_connect_policy_denial_creates_no_oauth_state(calendar_client, monkeypatch):
    def deny(self, descriptor, call, context):
        assert descriptor.required_scope == 'calendar.connect' and context.allow_external_effects
        raise PolicyDenied('Denied')
    monkeypatch.setattr(ServerPolicyEngine, 'authorize', deny)
    response = await calendar_client.client.post('/api/v1/calendar/google/connect')
    assert response.status_code == 403 and response.json()['detail']['code'] == 'POLICY_DENIED'
    async with calendar_client.sessions() as db:
        assert list((await db.execute(select(GoogleCalendarOAuthState))).scalars()) == []


async def test_refresh_preserves_missing_scope_and_refresh_token(calendar_client, monkeypatch):
    google_stub(monkeypatch)
    query, _ = await begin(calendar_client)
    assert (await finish(calendar_client, query)).status_code == 303
    async with calendar_client.sessions() as db:
        connection = (await db.execute(select(GoogleCalendarConnection))).scalar_one()
        credential = await db.get(GoogleCalendarCredential, connection.id)
        tokens = json.loads(decrypt_secret(credential.encrypted_tokens)); tokens['expires_at'] = time.time() - 1
        credential.encrypted_tokens = encrypt_secret(json.dumps(tokens)); await db.commit()
        async def refresh(method, url, **kwargs):
            assert method == 'POST' and url == 'https://oauth2.googleapis.com/token'
            assert kwargs['data']['refresh_token'] == 'private-refresh-token'
            return {'access_token': 'refreshed-token', 'expires_in': 3600}
        monkeypatch.setattr(calendar, 'google_calendar_request', refresh)
        assert await calendar.access_token(db, connection) == 'refreshed-token'
        await db.refresh(credential)
        updated = json.loads(decrypt_secret(credential.encrypted_tokens))
        assert updated['scope'] == SCOPE and updated['refresh_token'] == 'private-refresh-token'
        tokens['expires_at'] = time.time() - 1
        credential.encrypted_tokens = encrypt_secret(json.dumps(tokens)); await db.commit()
        async def invalid(*args, **kwargs): return {'access_token': 'bad-scope-token', 'scope': 'mail.write'}
        monkeypatch.setattr(calendar, 'google_calendar_request', invalid)
        with pytest.raises(HTTPException) as error:
            await calendar.access_token(db, connection)
        assert error.value.detail['code'] == 'CALENDAR_RECONNECT_REQUIRED'
        await db.refresh(credential)
        assert json.loads(decrypt_secret(credential.encrypted_tokens)) == tokens


async def test_reconnect_revives_same_owner_connection_and_clears_old_cursor(calendar_client, monkeypatch):
    google_stub(monkeypatch)
    query, _ = await begin(calendar_client)
    assert (await finish(calendar_client, query)).status_code == 303
    async with calendar_client.sessions() as db:
        connection = (await db.execute(select(GoogleCalendarConnection))).scalar_one()
        connection_id, version = connection.id, connection.version
        from app.core.models import now
        connection.connection_status, connection.deleted_at = 'disconnected', now()
        connection.encrypted_sync_token = encrypt_secret('old-sync-cursor')
        connection.last_synced_at, connection.last_error_code = now(), 'CALENDAR_RECONNECT_REQUIRED'
        connection.lease_owner, connection.lease_expires_at = 'old-worker', now()
        await db.commit()
    query, _ = await begin(calendar_client)
    assert (await finish(calendar_client, query)).status_code == 303
    async with calendar_client.sessions() as db:
        rows = list((await db.execute(select(GoogleCalendarConnection))).scalars())
        assert len(rows) == 1 and rows[0].id == connection_id and rows[0].version == version + 1
        assert rows[0].connection_status == 'connected' and rows[0].deleted_at is None
        assert rows[0].encrypted_sync_token is rows[0].last_synced_at is rows[0].last_error_code is None
        assert rows[0].lease_owner is rows[0].lease_expires_at is None


async def test_disconnect_during_refresh_cannot_restore_or_overwrite_credentials(calendar_client, monkeypatch):
    google_stub(monkeypatch)
    query, _ = await begin(calendar_client)
    assert (await finish(calendar_client, query)).status_code == 303
    async with calendar_client.sessions() as db:
        connection = (await db.execute(select(GoogleCalendarConnection))).scalar_one()
        credential = await db.get(GoogleCalendarCredential, connection.id)
        tokens = json.loads(decrypt_secret(credential.encrypted_tokens)); tokens['expires_at'] = 0
        credential.encrypted_tokens = encrypt_secret(json.dumps(tokens)); await db.commit()
        async def refresh(*args, **kwargs):
            async with calendar_client.sessions() as other:
                current = await other.get(GoogleCalendarConnection, connection.id)
                current.connection_status = 'disconnected'; current.version += 1
                await other.delete(await other.get(GoogleCalendarCredential, connection.id))
                await other.commit()
            return {'access_token': 'late-access-token'}
        monkeypatch.setattr(calendar, 'google_calendar_request', refresh)
        with pytest.raises(HTTPException) as error:
            await calendar.access_token(db, connection)
        assert error.value.detail['code'] == 'CALENDAR_RECONNECT_REQUIRED'
        await db.rollback()
    async with calendar_client.sessions() as db:
        assert list((await db.execute(select(GoogleCalendarCredential))).scalars()) == []
        assert (await db.execute(select(GoogleCalendarConnection.connection_status))).scalar_one() == 'disconnected'


async def test_status_unconfigured_typed_contract_and_anonymous_denial(calendar_client, monkeypatch):
    monkeypatch.setenv('AELYS_GMAIL_CLIENT_SECRET', '')
    get_settings.cache_clear()
    status = await calendar_client.client.get('/api/v1/calendar/google/status')
    assert status.json() == {'configured': False, 'connection': None}
    assert status.headers['cache-control'] == 'no-store'
    response = await calendar_client.client.post('/api/v1/calendar/google/connect')
    assert response.status_code == 503 and response.json()['detail']['code'] == 'CALENDAR_NOT_CONFIGURED'
    calendar_client.client.headers.pop('Authorization')
    assert (await calendar_client.client.get('/api/v1/calendar/google/status')).status_code == 401


async def test_calendar_denied_consent_consumes_state_without_google_io(calendar_client, monkeypatch):
    calls = google_stub(monkeypatch)
    query, _ = await begin(calendar_client)
    response = await calendar_client.client.get('/api/v1/calendar/google/callback',
        params={'state': query['state'][0], 'error': 'access_denied'})
    assert response.status_code == 303 and response.headers['location'] == 'https://test/settings?section=calendar'
    assert calls == []
    async with calendar_client.sessions() as db:
        assert list((await db.execute(select(GoogleCalendarOAuthState))).scalars()) == []


async def test_shared_extraction_keeps_gmail_callback_contract(calendar_client, monkeypatch):
    from app.domains import gmail
    async def request(method, url, **kwargs):
        if url.endswith('/token'):
            assert kwargs['data']['code_verifier']
            return {'access_token': 'gmail-access', 'refresh_token': 'gmail-refresh', 'scope': ' '.join(gmail.SCOPES)}
        assert method == 'GET' and url.endswith('/profile')
        return {'emailAddress': 'gmail@example.test'}
    monkeypatch.setattr(gmail, 'google', request)
    start = await calendar_client.client.post('/api/v1/mail/gmail/connect')
    state = parse_qs(urlparse(start.json()['authorization_url']).query)['state'][0]
    response = await calendar_client.client.get('/api/v1/mail/gmail/callback', params={'state': state, 'code': 'gmail-code'})
    assert response.status_code == 303 and response.headers['location'] == '/mail?gmail=connected'
    assert (await calendar_client.client.get('/api/v1/mail/gmail/callback', params={'state': state, 'code': 'gmail-code'})).status_code == 400


@pytest.mark.parametrize('method,url', [('POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events'),
    ('DELETE', 'https://www.googleapis.com/calendar/v3/calendars/primary'), ('GET', 'https://gmail.googleapis.com/gmail/v1/users/me'),
    ('POST', 'https://oauth2.googleapis.com/revoke'), ('GET', 'https://www.googleapis.com.evil.test/calendar/v3/calendars/primary'),
    ('GET', 'https://www.googleapis.com/calendar/v3/../../gmail/v1/users/me'),
    ('GET', 'https://www.googleapis.com/calendar/v3/%2e%2e/gmail')])
async def test_transport_refuses_other_origins_and_remote_writes(method, url):
    with pytest.raises(HTTPException):
        await calendar.google_calendar_request(method, url)


@pytest.mark.parametrize('status,code', [(401, 'CALENDAR_RECONNECT_REQUIRED'), (403, 'CALENDAR_RECONNECT_REQUIRED'),
    (410, 'CALENDAR_SYNC_EXPIRED'), (500, 'CALENDAR_UNAVAILABLE'), (302, 'CALENDAR_UNAVAILABLE')])
async def test_transport_sanitizes_provider_errors_and_logs(monkeypatch, caplog, status, code):
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json={'error': 'private-access-token private-calendar-content'}))
    monkeypatch.setattr(calendar.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=transport, **kwargs))
    caplog.set_level(logging.DEBUG)
    with pytest.raises(HTTPException) as error:
        await calendar.google_calendar_request('GET', 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
            headers={'Authorization': 'Bearer private-access-token'}, params={'syncToken': 'private-sync-token'})
    assert error.value.detail['code'] == code
    assert all(secret not in str(error.value.detail) + caplog.text for secret in ['private-access-token', 'private-calendar-content', 'private-sync-token'])


async def test_token_invalid_grant_requires_reconnect_without_provider_error_leak(monkeypatch, caplog):
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(400, json={
        'error': 'invalid_grant', 'error_description': 'private-refresh-token provider detail'}))
    monkeypatch.setattr(calendar.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=transport, **kwargs))
    with pytest.raises(HTTPException) as error:
        await calendar.google_calendar_request('POST', 'https://oauth2.googleapis.com/token',
            data={'refresh_token': 'private-refresh-token'})
    assert error.value.detail['code'] == 'CALENDAR_RECONNECT_REQUIRED'
    assert 'private-refresh-token' not in str(error.value.detail) + caplog.text


async def test_callback_authorizes_each_token_and_profile_egress(calendar_client, monkeypatch):
    original = ServerPolicyEngine.authorize
    checks = []
    def authorize(self, descriptor, call, context):
        checks.append((descriptor.required_scope, descriptor.external_effect))
        return original(self, descriptor, call, context)
    monkeypatch.setattr(ServerPolicyEngine, 'authorize', authorize)
    async def request(method, url, **kwargs):
        assert checks.pop() == ('calendar.connect', True)
        if method == 'POST':
            return {'access_token': 'access', 'refresh_token': 'refresh', 'scope': SCOPE}
        return {'id': 'primary@example.test', 'timeZone': 'UTC'}
    monkeypatch.setattr(calendar, 'google_calendar_request', request)
    query, _ = await begin(calendar_client)
    checks.clear()
    assert (await finish(calendar_client, query)).status_code == 303
