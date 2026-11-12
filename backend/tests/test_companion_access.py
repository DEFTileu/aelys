import re

import pytest
import pytest_asyncio
from app.companion.access import COMPANION_ALLOWED
from app.core import db
from app.core.models import Device
from app.core.security import create_token, current_principal, decode_token
from app.main import app
from companion_helpers import (
    B,
    Key,
    bearer,
    claim_owner,
    companion_login,
    companion_token,
    pair_companion,
    setup_token,
)
from fastapi.routing import APIRoute, iter_route_contexts
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

# Routes that never ask for a principal; a new one must be added here on purpose.
PUBLIC_ROUTES = {
    ('GET', '/healthz'),
    ('POST', '/api/v1/auth/login'),
    ('POST', '/api/v1/auth/refresh'),
    ('POST', '/api/v1/auth/bootstrap'),
    ('POST', '/api/v1/auth/setup/claim'),
    ('POST', '/api/v1/auth/device/challenge'),
    ('POST', '/api/v1/auth/device/login'),
    ('POST', '/api/v1/pairing/request'),
    ('POST', '/api/v1/pairing/{pairing_id}/claim'),
    ('POST', '/api/v1/pairing/{pairing_id}/finish'),
    ('GET', '/api/v1/auth/browser/status'),
    ('POST', '/api/v1/auth/browser/login'),
    ('POST', '/api/v1/auth/browser/bootstrap'),
    ('POST', '/api/v1/auth/browser/refresh'),
    ('POST', '/api/v1/auth/browser/logout'),
    ('GET', '/api/v1/auth/native/status'),
    ('POST', '/api/v1/auth/native/login'),
    ('POST', '/api/v1/auth/native/bootstrap'),
    ('POST', '/api/v1/auth/native/refresh'),
    ('POST', '/api/v1/auth/native/logout'),
    # Single-use tickets minted by authenticated routes, so a companion cannot obtain one.
    ('GET', '/api/v1/mail/gmail/authorize'),
    ('GET', '/api/v1/mail/gmail/callback'),
    ('GET', '/api/v1/calendar/google/authorize'),
    ('GET', '/api/v1/calendar/google/callback'),
}


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/companion.db')
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        yield http
    await engine.dispose()


def _needs_principal(dependant) -> bool:
    return any(item.call is current_principal or _needs_principal(item) for item in dependant.dependencies)


def api_routes():
    """(method, full path template, requires a principal) for every HTTP route, prefixes included."""
    for context in iter_route_contexts(app.routes):
        if isinstance(context.original_route, APIRoute):
            for method in sorted(context.methods - {'HEAD', 'OPTIONS'}):
                yield method, context.path_format, _needs_principal(context.original_route.dependant)


@pytest.mark.asyncio
async def test_companion_pairs_through_request_flow(client):
    _, _, device_id = await pair_companion(client)
    async with db.SessionLocal() as session:
        assert (await session.get(Device, device_id)).platform == 'companion'


@pytest.mark.asyncio
async def test_companion_cannot_claim_setup_or_register_key(client):
    key = Key()
    token = await setup_token()
    claim = await client.post(f'{B}/auth/setup/claim', json={'token': token, 'public_key': key.public, 'platform': 'companion', 'display_name': 'Desk'})
    assert claim.status_code == 422 and claim.json()['detail']['code'] == 'PLATFORM_NOT_ALLOWED'
    # The rejected claim neither burned the token nor created an owner.
    ok = await client.post(f'{B}/auth/setup/claim', json={'token': token, 'public_key': Key().public, 'platform': 'macos', 'display_name': 'Mac'})
    assert ok.status_code == 200
    owner = ok.json()
    me = (await client.get(f'{B}/me', headers=bearer(owner))).json()
    register = await client.post(f'{B}/devices/register-key', headers=bearer(owner), json={'public_key': key.public, 'platform': 'companion', 'display_name': 'Desk', 'proof': key.sign(f"aelys-device-register-v1\n{me['id']}\n{key.public}")})
    assert register.status_code == 422 and register.json()['detail']['code'] == 'PLATFORM_NOT_ALLOWED'
    enroll = await client.post(f'{B}/devices/enroll', headers=bearer(owner), json={'platform': 'companion', 'display_name': 'Desk'})
    assert enroll.status_code == 422


@pytest.mark.asyncio
async def test_companion_login_returns_no_refresh(client):
    _, key, device_id = await pair_companion(client)
    login = await companion_login(client, key, device_id)
    assert login.status_code == 200 and login.json()['refresh_token'] is None
    claims = decode_token(login.json()['access_token'])
    # Even a validly signed refresh token naming the board is refused.
    forged = create_token(claims['sub'], 'refresh', 3600, device_id, claims['sid'])
    denied = await client.post(f'{B}/auth/refresh', json={'refresh_token': forged})
    assert denied.status_code == 403 and denied.json()['detail']['code'] == 'DEVICE_SCOPE_DENIED'


@pytest.mark.asyncio
async def test_owner_devices_unaffected(client):
    _, owner = await claim_owner(client)
    assert (await client.get(f'{B}/tasks', headers=bearer(owner))).status_code == 200
    assert (await client.post(f'{B}/auth/refresh', json={'refresh_token': owner['refresh_token']})).status_code == 200


@pytest.mark.asyncio
async def test_companion_denied_everywhere_but_allow_list(client):
    _, key, device_id = await pair_companion(client)
    headers = {'Authorization': f'Bearer {await companion_token(client, key, device_id)}'}
    fixed = '00000000-0000-4000-8000-000000000000'
    checked = set()
    for method, template, needs_principal in api_routes():
        if not needs_principal or (method, template) in COMPANION_ALLOWED:
            continue
        response = await client.request(method, re.sub(r'\{[^}]+\}', fixed, template), headers=headers, json={})
        assert response.status_code == 403 and response.json()['detail']['code'] == 'DEVICE_SCOPE_DENIED', (method, template, response.status_code, response.text[:200])
        checked.add((method, template))
    for named in (('POST', f'{B}/pairing/invite'), ('POST', f'{B}/pairing/{{pairing_id}}/approve'), ('POST', f'{B}/devices/{{device_id}}/revoke'), ('POST', f'{B}/devices/register-key'), ('GET', f'{B}/sync/pull')):
        assert named in checked, named


def test_public_routes_are_exactly_the_known_ones():
    assert {(method, template) for method, template, needs_principal in api_routes() if not needs_principal} == PUBLIC_ROUTES
