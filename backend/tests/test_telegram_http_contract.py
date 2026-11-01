"""Credential failures must not echo write-only Telegram secrets."""
import pytest
from app.core import db
from app.core.db import Base
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.asyncio
async def test_secret_validation_redaction_and_protected_contracts(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/contract.db')
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        prefix = '/api/v1/integrations/telegram'
        for method, path, body in [('GET', '/status', None), ('GET', '/messages', None), ('POST', '/binding', {}), ('POST', '/connect', {'bot_token': 'secret-invalid-token'}), ('POST', '/disconnect', {}), ('POST', '/sync', {}), ('PATCH', '/settings', {'version': 1, 'auto_reply': True})]:
            result = await client.request(method, prefix + path, json=body)
            assert result.status_code == 401
        tokens = (await client.post('/api/v1/auth/bootstrap', json={'email': 'owner@example.test', 'password': 'disposable-test-password'})).json()
        client.headers['Authorization'] = 'Bearer ' + tokens['access_token']
        for value in ['tiny-secret', 'secret' * 100]:
            response = await client.post(prefix + '/connect', json={'bot_token': value})
            assert response.status_code == 422
            assert value not in response.text
            assert response.json()['detail']['code'] == 'VALIDATION_ERROR'
            assert response.headers['cache-control'] == 'no-store'
        status = (await client.get(prefix + '/status')).json()
        assert status['configured'] is False and not status['auto_reply']
        assert 'bot_token' not in status and 'encrypted_token' not in status
        schema = app.openapi()
        for path in [prefix + '/status', prefix + '/connect', prefix + '/settings', prefix + '/messages/{message_id}/send']:
            for operation in schema['paths'][path].values():
                assert {'HTTPBearer': []} in operation['security']
    await engine.dispose()


@pytest.mark.parametrize('patch', [
    {'timezone': 'Mars/Olympus'}, {'timezone': None}, {'reply_delay_seconds': -1},
    {'reply_delay_seconds': 901}, {'digest_time': '25:00'}, {'digest_time': '8:00'},
])
async def test_personal_settings_validation(setup, patch):
    from test_telegram_business import PREFIX, connect
    client, _, _ = setup
    item = await connect(client)
    response = await client.patch(PREFIX+'/settings', json={'version': item['version'], **patch})
    assert response.status_code == 422


async def test_personal_settings_roundtrip(setup):
    from test_telegram_business import PREFIX, connect
    client, _, _ = setup
    item = await connect(client)
    assert item['timezone'] == 'UTC' and item['digest_time'] is None and item['reply_delay_seconds'] == 90
    values = {'timezone': 'Asia/Almaty', 'digest_time': '20:00', 'reply_delay_seconds': 120}
    result = await client.patch(PREFIX+'/settings', json={'version': item['version'], **values})
    assert result.status_code == 200
    reloaded = (await client.get(PREFIX+'/status')).json()
    assert all(reloaded[key] == value for key, value in values.items())
    off = await client.patch(PREFIX+'/settings', json={'version': reloaded['version'], 'digest_time': None})
    assert off.status_code == 200 and off.json()['digest_time'] is None


pytest_plugins = ("test_telegram_business",)
