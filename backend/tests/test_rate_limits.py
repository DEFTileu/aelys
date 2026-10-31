import pytest
import pytest_asyncio
from app.core import db
from app.core.config import Settings, get_settings
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

B = '/api/v1'


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/limits.db')
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        yield http
    await engine.dispose()


def login(client, email='owner@example.test', password='wrong-password', headers=None):
    return client.post(f'{B}/auth/login', json={'email': email, 'password': password}, headers=headers or {})


def test_password_bootstrap_is_off_unless_an_operator_enables_it():
    assert Settings.model_fields['password_bootstrap_enabled'].default is False
    assert Settings.model_fields['password_login_enabled'].default is True


@pytest.mark.asyncio
async def test_guessing_one_account_is_throttled_even_with_the_right_password_afterwards(client):
    assert (await client.post(f'{B}/auth/bootstrap', json={'email': 'owner@example.test', 'password': 'right-password'})).status_code == 200
    codes = [(await login(client)).status_code for _ in range(8)]
    assert codes == [401] * 8
    blocked = await login(client)
    assert blocked.status_code == 429 and blocked.json()['detail']['code'] == 'RATE_LIMITED'
    assert int(blocked.headers['Retry-After']) >= 1
    assert (await login(client, password='right-password')).status_code == 429
    # Another account from the same address is still under the per-address allowance.
    assert (await login(client, email='other@example.test')).status_code == 401


@pytest.mark.asyncio
async def test_spraying_many_accounts_from_one_address_is_throttled(client):
    codes = [(await login(client, email=f'user{i}@example.test')).status_code for i in range(31)]
    assert codes[:30] == [401] * 30 and codes[30] == 429


@pytest.mark.asyncio
async def test_a_spoofed_forwarded_header_does_not_bypass_the_limit(client):
    codes = [(await login(client, email=f'spoof{i}@example.test', headers={'X-Forwarded-For': f'203.0.113.{i}'})).status_code for i in range(31)]
    assert codes[30] == 429


@pytest.mark.asyncio
async def test_trusted_proxy_address_is_used_when_configured(client, monkeypatch):
    monkeypatch.setattr(get_settings(), 'trusted_proxy_count', 1)
    for i in range(30):
        assert (await login(client, email=f'a{i}@example.test', headers={'X-Forwarded-For': '198.51.100.1'})).status_code == 401
    assert (await login(client, email='b@example.test', headers={'X-Forwarded-For': '198.51.100.1'})).status_code == 429
    assert (await login(client, email='c@example.test', headers={'X-Forwarded-For': '198.51.100.2'})).status_code == 401


@pytest.mark.asyncio
async def test_password_login_can_be_switched_off(client, monkeypatch):
    monkeypatch.setattr(get_settings(), 'password_login_enabled', False)
    disabled = await login(client)
    assert disabled.status_code == 403 and disabled.json()['detail']['code'] == 'PASSWORD_LOGIN_DISABLED'


@pytest.mark.asyncio
async def test_setup_token_guessing_and_pairing_probes_are_throttled(client):
    from tests.test_device_pairing import Key
    claim = {'token': 'x' * 32, 'public_key': Key().public, 'platform': 'macos', 'display_name': 'Probe'}
    codes = [(await client.post(f'{B}/auth/setup/claim', json=claim)).status_code for _ in range(11)]
    assert codes[:10] == [401] * 10 and codes[10] == 429
    probe = {'secret': 'y' * 40, 'public_key': Key().public, 'platform': 'android', 'display_name': 'Probe'}
    pairing = [(await client.post(f'{B}/pairing/missing/claim', json=probe)).status_code for _ in range(21)]
    assert pairing[:20] == [404] * 20 and pairing[20] == 429
