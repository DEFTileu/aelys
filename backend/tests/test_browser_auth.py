"""Browser entry, cookie rotation and owner/device isolation without a real account."""
import asyncio

import pytest
from app.core import db
from app.core.browser_auth import COOKIE, COOKIE_PATH
from app.core.db import Base
from app.core.models import AuthSession, Device, User
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

PREFIX = '/api/v1/auth/browser'
CREDENTIALS = {'email': 'browser@test.example', 'password': 'disposable-browser-test-password'}


@pytest.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/browser.db')
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='https://test', headers={'X-Aelys-Browser': '1', 'Origin': 'https://test'}) as client:
        yield client
    await engine.dispose()


@pytest.mark.asyncio
async def test_one_entry_cookie_restore_rotation_logout_and_modules(client):
    assert (await client.get(f'{PREFIX}/status')).json() == {'initialized': False, 'can_resume': False, 'password_setup': True}
    created = await client.post(f'{PREFIX}/bootstrap', json=CREDENTIALS)
    assert created.status_code == 200, created.text
    assert set(created.json()) == {'access_token', 'device_id', 'token_type'}
    cookie = created.headers['set-cookie']
    assert 'HttpOnly' in cookie and 'Secure' in cookie and 'SameSite=strict' in cookie and f'Path={COOKIE_PATH}' in cookie
    original_refresh = client.cookies.get(COOKIE)
    original_access = created.json()['access_token']
    auth = {'Authorization': f'Bearer {original_access}'}
    assert (await client.get(f'{PREFIX}/status')).json() == {'initialized': True, 'can_resume': True, 'password_setup': True}
    for path in ['/tasks', '/finance/accounts', '/calendar/events', '/mail/messages', '/ai/providers']:
        assert (await client.get(f'/api/v1{path}', headers=auth)).status_code == 200
    rotated = await client.post(f'{PREFIX}/refresh')
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()['device_id'] == created.json()['device_id']
    assert client.cookies.get(COOKIE) != original_refresh
    # Other tabs remain signed in while their short-lived access token is valid.
    assert (await client.get('/api/v1/me', headers=auth)).status_code == 200
    assert (await client.post(f'{PREFIX}/refresh', headers={'Cookie': f'{COOKIE}={original_refresh}'})).status_code == 401
    assert (await client.post(f'{PREFIX}/logout')).status_code == 200
    assert (await client.get('/api/v1/me', headers=auth)).status_code == 401
    assert (await client.get('/api/v1/me', headers={'Authorization': f"Bearer {rotated.json()['access_token']}"})).status_code == 401
    assert (await client.get(f'{PREFIX}/status')).json()['can_resume'] is False
    assert (await client.post(f'{PREFIX}/refresh')).status_code == 401
    logged_in = await client.post(f'{PREFIX}/login', json=CREDENTIALS)
    assert logged_in.status_code == 200
    assert (await client.get('/api/v1/me', headers={'Authorization': f"Bearer {logged_in.json()['access_token']}"})).json()['device_id'] == logged_in.json()['device_id']


@pytest.mark.asyncio
async def test_existing_owner_cannot_be_replaced_and_wrong_password_is_rejected(client):
    assert (await client.post(f'{PREFIX}/bootstrap', json=CREDENTIALS)).status_code == 200
    assert (await client.post(f'{PREFIX}/bootstrap', json={**CREDENTIALS, 'email': 'other@example.test'})).status_code == 409
    assert (await client.post(f'{PREFIX}/login', json={**CREDENTIALS, 'password': 'wrong-password'})).status_code == 401
    async with db.SessionLocal() as session:
        assert len((await session.execute(select(User))).scalars().all()) == 1
        device = (await session.execute(select(Device))).scalar_one()
        auth_session = (await session.execute(select(AuthSession))).scalar_one()
        assert auth_session.device_id == device.id and auth_session.owner_id == device.owner_id


@pytest.mark.asyncio
async def test_concurrent_setup_creates_exactly_one_owner(client):
    results = await asyncio.gather(client.post(f'{PREFIX}/bootstrap', json=CREDENTIALS), client.post(f'{PREFIX}/bootstrap', json=CREDENTIALS))
    assert sorted(response.status_code for response in results) == [200, 409]


@pytest.mark.asyncio
@pytest.mark.parametrize('headers', [
    {'X-Aelys-Browser': ''},
    {'Origin': 'https://attacker.test'},
    {'Origin': 'null'},
    {'Sec-Fetch-Site': 'cross-site'},
])
async def test_browser_mutations_reject_forged_cross_site_requests(client, headers):
    for operation in ['bootstrap', 'login', 'refresh', 'logout']:
        response = await client.post(f'{PREFIX}/{operation}', headers=headers, json=CREDENTIALS)
        assert response.status_code == 403
        assert response.headers['cache-control'] == 'no-store'
        assert response.json()['detail']['code'] == 'CSRF_DENIED'
    assert (await client.get(f'{PREFIX}/status')).json()['initialized'] is False


@pytest.mark.asyncio
async def test_revoked_device_cannot_restore_or_access_modules(client):
    created = (await client.post(f'{PREFIX}/bootstrap', json=CREDENTIALS)).json()
    auth = {'Authorization': f"Bearer {created['access_token']}"}
    assert (await client.post(f"/api/v1/devices/{created['device_id']}/revoke", headers=auth)).status_code == 200
    assert (await client.get(f'{PREFIX}/status')).json()['can_resume'] is False
    assert (await client.post(f'{PREFIX}/refresh')).status_code == 401
    assert (await client.get('/api/v1/tasks', headers=auth)).status_code == 401


@pytest.mark.asyncio
async def test_loopback_development_cookie_and_vite_proxy_origin(client):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://127.0.0.1:8000', headers={'X-Aelys-Browser': '1', 'Origin': 'http://127.0.0.1:5173'}) as local:
        response = await local.post(f'{PREFIX}/bootstrap', json=CREDENTIALS)
        assert response.status_code == 200
        assert 'HttpOnly' in response.headers['set-cookie']
        assert 'Secure' not in response.headers['set-cookie']
        assert (await local.post(f'{PREFIX}/refresh')).status_code == 200


@pytest.mark.asyncio
async def test_local_one_one_account_uses_normal_owner_password_and_sessions(client):
    transport = ASGITransport(app=app, client=('127.0.0.1', 12345))
    async with AsyncClient(transport=transport, base_url='http://127.0.0.1:5187', headers={'X-Aelys-Browser': '1', 'Origin': 'http://127.0.0.1:5187'}) as local:
        credentials = {'email': '1', 'password': '1'}
        created = await local.post(f'{PREFIX}/bootstrap', json=credentials)
        assert created.status_code == 200, created.text
        assert (await local.post(f'{PREFIX}/logout')).status_code == 200
        logged_in = await local.post(f'{PREFIX}/login', json=credentials)
        assert logged_in.status_code == 200
        auth = {'Authorization': f"Bearer {logged_in.json()['access_token']}"}
        assert (await local.get('/api/v1/me', headers=auth)).json()['email'] == '1'
        assert (await local.post(f'{PREFIX}/login', json={'email': '1', 'password': '2'})).status_code == 422
        async with db.SessionLocal() as session:
            owner = (await session.execute(select(User))).scalar_one()
            assert owner.email == '1' and owner.password_hash != '1'


@pytest.mark.asyncio
@pytest.mark.parametrize(('peer', 'origin'), [
    ('203.0.113.10', 'http://127.0.0.1:5187'),
    ('127.0.0.1', 'https://aelys.example.test'),
])
async def test_one_one_credentials_rejected_outside_loopback(client, peer, origin):
    async with AsyncClient(transport=ASGITransport(app=app, client=(peer, 12345)), base_url=origin, headers={'X-Aelys-Browser': '1', 'Origin': origin}) as remote:
        for operation in ('bootstrap', 'login'):
            response = await remote.post(f'{PREFIX}/{operation}', json={'email': '1', 'password': '1'})
            assert response.status_code == 422
    assert (await client.get(f'{PREFIX}/status')).json()['initialized'] is False


@pytest.mark.asyncio
async def test_local_one_one_does_not_override_an_existing_owner(client):
    assert (await client.post(f'{PREFIX}/bootstrap', json=CREDENTIALS)).status_code == 200
    async with AsyncClient(transport=ASGITransport(app=app, client=('127.0.0.1', 12345)), base_url='http://localhost', headers={'X-Aelys-Browser': '1'}) as local:
        credentials = {'email': '1', 'password': '1'}
        assert (await local.post(f'{PREFIX}/bootstrap', json=credentials)).status_code == 409
        assert (await local.post(f'{PREFIX}/login', json=credentials)).status_code == 401
        assert (await local.post('/api/v1/auth/login', json=credentials)).status_code == 422


@pytest.mark.asyncio
async def test_browser_and_native_bootstrap_share_the_owner_lock(client):
    results = await asyncio.gather(client.post(f'{PREFIX}/bootstrap', json=CREDENTIALS), client.post('/api/v1/auth/bootstrap', json=CREDENTIALS))
    assert sorted(response.status_code for response in results) == [200, 409]


@pytest.mark.asyncio
async def test_expired_or_tampered_refresh_cannot_resume(client):
    from datetime import timedelta

    from app.core.models import now
    created = await client.post(f'{PREFIX}/bootstrap', json=CREDENTIALS)
    assert created.status_code == 200
    async with db.SessionLocal() as session:
        record = (await session.execute(select(AuthSession))).scalar_one()
        record.expires_at = now() - timedelta(seconds=1)
        await session.commit()
    assert (await client.get(f'{PREFIX}/status')).json()['can_resume'] is False
    assert (await client.post(f'{PREFIX}/refresh')).status_code == 401
    assert (await client.post(f'{PREFIX}/refresh', headers={'Cookie': f'{COOKIE}=invalid-token'})).status_code == 401


@pytest.mark.asyncio
async def test_local_one_one_respects_operator_password_switches(client, monkeypatch):
    from app.core.config import get_settings

    async with AsyncClient(transport=ASGITransport(app=app, client=('127.0.0.1', 12345)), base_url='http://localhost', headers={'X-Aelys-Browser': '1'}) as local:
        credentials = {'email': '1', 'password': '1'}
        monkeypatch.setattr(get_settings(), 'password_bootstrap_enabled', False)
        response = await local.post(f'{PREFIX}/bootstrap', json=credentials)
        assert response.status_code == 403
        assert response.json()['detail']['code'] == 'BOOTSTRAP_DISABLED'
        monkeypatch.setattr(get_settings(), 'password_login_enabled', False)
        response = await local.post(f'{PREFIX}/login', json=credentials)
        assert response.status_code == 403
        assert response.json()['detail']['code'] == 'PASSWORD_LOGIN_DISABLED'
