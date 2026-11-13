"""The whole board flow in one test: pair, log in, receive, act, get commanded, get revoked."""
import uuid
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from app.companion.hub import hub, install_change_listeners
from app.core import db
from app.main import app
from companion_helpers import B, bearer, companion_login, pair_companion
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

CHANNEL = f'{B}/devices/channel'


@pytest_asyncio.fixture
async def engine(tmp_path, monkeypatch):
    eng = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/e2e.db')
    async with eng.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(eng, expire_on_commit=False))
    monkeypatch.setattr(hub, 'debounce', 0.01)
    hub._owner_locks.clear()
    install_change_listeners()
    yield eng
    await eng.dispose()


@pytest.mark.asyncio
async def test_companion_full_flow(engine):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        owner, key, device_id = await pair_companion(http)  # claim setup, then request/approve/finish
        login = await companion_login(http, key, device_id)
        assert login.status_code == 200, login.text
        assert not login.json().get('refresh_token')
        token = login.json()['access_token']

    with TestClient(app) as client, client.websocket_connect(CHANNEL, headers={'Authorization': f'Bearer {token}'}) as socket:
        assert socket.receive_json() == {'type': 'ready', 'device_id': device_id}
        first = socket.receive_json()
        assert first['type'] == 'snapshot' and first['snapshot']['next_task'] is None

        due = (datetime.now(UTC) + timedelta(days=1)).isoformat()
        created = client.post(f'{B}/tasks', json={'title': 'Pay rent', 'due_at': due}, headers=bearer(owner))
        assert created.status_code == 200, created.text
        message = socket.receive_json()
        assert message['type'] == 'snapshot' and message['snapshot']['next_task']['id'] == created.json()['id']

        action_id = str(uuid.uuid4())
        socket.send_json({'type': 'action', 'id': action_id, 'kind': 'focus.start', 'payload': {'mode': 'pomodoro'}})
        assert socket.receive_json() == {'type': 'action_result', 'id': action_id, 'ok': True}
        assert socket.receive_json()['snapshot']['focus']['status'] == 'active'

        lost = client.put(f'{B}/companion/devices/{device_id}/lost-mode', json={'on': True, 'message': 'Call me', 'show_phone': False, 'show_telegram': False}, headers=bearer(owner))
        assert lost.status_code == 200, lost.text
        command = socket.receive_json()
        while command['type'] == 'snapshot':  # a snapshot may interleave; only the command matters
            command = socket.receive_json()
        assert (command['type'], command['name'], command['id']) == ('command', 'lost_mode', lost.json()['id'])
        assert command['args']['on'] is True and command['args']['rev'] >= 1
        socket.send_json({'type': 'command_ack', 'id': command['id'], 'ok': True})
        socket.send_json({'type': 'heartbeat'})
        while (reply := socket.receive_json())['type'] == 'snapshot':
            pass
        assert reply == {'type': 'heartbeat_ack'}

        assert client.post(f'{B}/devices/{device_id}/revoke', headers=bearer(owner)).status_code == 200
        with pytest.raises(WebSocketDisconnect) as info:
            while True:
                socket.receive_json()
        assert info.value.code == 4403

    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        denied = await http.post(f'{B}/auth/device/challenge', json={'device_id': device_id})
        assert denied.status_code == 401 and denied.json()['detail']['code'] == 'UNAUTHORIZED', denied.text
