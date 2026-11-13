import asyncio
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from app.companion import channel as channel_module
from app.companion.hub import hub, install_change_listeners
from app.companion.models import CompanionState
from app.core import db
from app.core.models import AuthSession, Device
from app.core.security import create_token
from app.main import app
from companion_helpers import B, bearer, companion_token, pair_companion
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

CHANNEL = f'{B}/devices/channel'
C1, C2 = str(uuid.uuid4()), str(uuid.uuid4())


@pytest_asyncio.fixture
async def engine(tmp_path, monkeypatch):
    eng = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/channel.db')
    async with eng.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(eng, expire_on_commit=False))
    monkeypatch.setattr(hub, 'debounce', 0.01)
    hub._owner_locks.clear()  # locks bind to the loop that contended them first; each test has its own loops
    install_change_listeners()
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def paired(engine):
    """Owner session, board key, board device id and a board access token; the async client is only for setup."""
    from httpx import ASGITransport, AsyncClient
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        owner, key, device_id = await pair_companion(client)
        token = await companion_token(client, key, device_id)
    return owner, device_id, token


def headers(token):
    return {'Authorization': f'Bearer {token}'}


@contextmanager
def board(client, token):
    with client.websocket_connect(CHANNEL, headers=headers(token)) as socket:
        assert socket.receive_json()['type'] == 'ready'
        assert socket.receive_json()['type'] == 'snapshot'
        yield socket


def close_code(client, token):
    with pytest.raises(WebSocketDisconnect) as info, client.websocket_connect(CHANNEL, headers=headers(token)) as socket:
        socket.receive_json()
    return info.value.code


async def state_of(device_id):
    async with db.SessionLocal() as session:
        return (await session.execute(select(CompanionState).where(CompanionState.device_id == device_id))).scalar_one_or_none()


@pytest.mark.asyncio
async def test_ready_then_snapshot(paired):
    _, device_id, token = paired
    with TestClient(app) as client, client.websocket_connect(CHANNEL, headers=headers(token)) as socket:
        assert socket.receive_json() == {'type': 'ready', 'device_id': device_id}
        snapshot = socket.receive_json()
        assert snapshot['type'] == 'snapshot' and snapshot['snapshot']['next_task'] is None
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json() == {'type': 'heartbeat_ack'}


@pytest.mark.asyncio
async def test_non_companion_device_gets_4403(paired):
    owner, _, _ = paired
    with TestClient(app) as client:
        # The owner's own Mac session is a device session, but not a companion.
        assert close_code(client, owner['access_token']) == 4403


@pytest.mark.asyncio
async def test_bad_token_gets_4401(paired):
    _, _, token = paired
    with TestClient(app) as client:
        assert close_code(client, 'not-a-token') == 4401
        assert close_code(client, '') == 4401
        refresh = create_token('x', 'refresh', 60, 'd', 's')
        assert close_code(client, refresh) == 4401
        assert close_code(client, token[:-2] + 'xx') == 4401
        with pytest.raises(WebSocketDisconnect) as info, client.websocket_connect(f'{CHANNEL}?token={token}') as socket:  # header only, never the query
            socket.receive_json()
        assert info.value.code == 4401


@pytest.mark.asyncio
async def test_action_over_channel_returns_result(paired):
    _, _, token = paired
    action_id = str(uuid.uuid4())
    with TestClient(app) as client, board(client, token) as socket:
        socket.send_json({'type': 'action', 'id': action_id, 'kind': 'focus.pause', 'payload': {}})
        assert socket.receive_json() == {'type': 'action_result', 'id': action_id, 'ok': False, 'error_code': 'NO_ACTIVE_FOCUS'}
        start_id = str(uuid.uuid4())
        socket.send_json({'type': 'action', 'id': start_id, 'kind': 'focus.start', 'payload': {'mode': 'pomodoro'}})
        assert socket.receive_json() == {'type': 'action_result', 'id': start_id, 'ok': True}
        # The focus change also pushes a fresh snapshot to the board.
        assert socket.receive_json()['snapshot']['focus']['status'] == 'active'
        socket.send_json({'type': 'action', 'id': 'not-a-uuid', 'kind': 'focus.stop', 'payload': {}})
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'
        socket.send_json({'type': 'action', 'id': str(uuid.uuid4()), 'kind': 'focus.stop', 'payload': []})
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'


@pytest.mark.asyncio
async def test_owner_creates_task_board_receives_new_snapshot(paired):
    owner, _, token = paired
    due = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    with TestClient(app) as client, board(client, token) as socket:
        created = client.post(f'{B}/tasks', json={'title': 'Pay rent', 'due_at': due}, headers=bearer(owner))
        assert created.status_code == 200, created.text
        message = socket.receive_json()
        assert message['type'] == 'snapshot' and message['snapshot']['next_task']['id'] == created.json()['id']


@pytest.mark.asyncio
async def test_revoke_closes_open_socket_within_1s(paired):
    owner, device_id, token = paired
    with TestClient(app) as client, board(client, token) as socket:
        started = time.monotonic()
        assert client.post(f'{B}/devices/{device_id}/revoke', headers=bearer(owner)).status_code == 200
        with pytest.raises(WebSocketDisconnect) as info:
            socket.receive_json()
        assert info.value.code == 4403 and time.monotonic() - started < 1


@pytest.mark.asyncio
async def test_new_connection_replaces_old_with_4000(paired):
    _, _, token = paired
    with TestClient(app) as client, board(client, token) as first, board(client, token) as second:
        with pytest.raises(WebSocketDisconnect) as info:
            first.receive_json()
        assert info.value.code == 4000
        second.send_json({'type': 'heartbeat'})
        assert second.receive_json() == {'type': 'heartbeat_ack'}


@pytest.mark.asyncio
async def test_hello_flushes_pending_commands_until_acked(paired):
    _, device_id, token = paired
    async with db.SessionLocal() as session:
        device = await session.get(Device, device_id)
        session.add(CompanionState(device_id=device_id, owner_id=device.owner_id, pending_commands_json=[
            {'id': C1, 'name': 'lost_mode', 'args': {'on': True, 'message': 'hi', 'show_phone': False, 'show_telegram': False}},
            {'id': C2, 'name': 'ice_update', 'args': {'contacts': [], 'med_note': '', 'show_name': False}}]))
        await session.commit()
    hello = {'type': 'hello', 'fw_version': '0.4.1', 'board': 'esp32-s3-n16r8', 'features': ['display']}
    with TestClient(app) as client:
        with board(client, token) as socket:
            socket.send_json(hello)
            first, second = socket.receive_json(), socket.receive_json()
            assert (first['type'], first['id'], first['name']) == ('command', C1, 'lost_mode') and first['args']['on'] is True
            assert (second['id'], second['name']) == (C2, 'ice_update')
            socket.send_json({'type': 'command_ack', 'id': C1, 'ok': True})
            socket.send_json({'type': 'heartbeat'})  # replies are ordered, so once this answers the ack was handled
            assert socket.receive_json() == {'type': 'heartbeat_ack'}
        with board(client, token) as socket:  # the unacked command comes again
            socket.send_json(hello)
            again = socket.receive_json()
            assert again['id'] == C2
    row = await state_of(device_id)
    assert row.fw_version == '0.4.1' and row.board == 'esp32-s3-n16r8' and row.last_hello_at is not None
    assert [c['id'] for c in row.pending_commands_json] == [C2]


@pytest.mark.asyncio
async def test_heartbeat_metrics_and_wifi_scan_are_stored(paired):
    _, device_id, token = paired
    metrics = {'heap_min_internal': 84312, 'largest_block': 61440, 'psram_free': 7864320, 'wifi_reconnects': 2, 'uptime_s': 3600}
    networks = [{'ssid': 'HomeNet', 'rssi': -48, 'secure': True}]
    with TestClient(app) as client, board(client, token) as socket:
        socket.send_json({'type': 'heartbeat'})
        socket.send_json({'type': 'metrics', **metrics})
        socket.send_json({'type': 'wifi_scan_result', 'id': 'scan-1', 'networks': networks})
        socket.send_json({'type': 'metrics', 'heap_min_internal': -1})  # invalid: reported, nothing stored
        assert socket.receive_json() == {'type': 'heartbeat_ack'}
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'
    row = await state_of(device_id)
    assert row.last_metrics_json == metrics
    assert row.last_wifi_scan_json['id'] == 'scan-1' and row.last_wifi_scan_json['networks'] == networks
    async with db.SessionLocal() as session:
        assert (await session.get(Device, device_id)).last_seen_at is not None


@pytest.mark.asyncio
async def test_bad_frames_get_errors_and_connection_survives(paired):
    _, _, token = paired
    with TestClient(app) as client, board(client, token) as socket:
        for frame in ('not json', '[1]', '{"type": 5}', '{}'):
            socket.send_text(frame)
            assert socket.receive_json()['code'] == 'VALIDATION_ERROR'
        socket.send_text('{"type": "ping", "pad": "' + 'x' * 4096 + '"}')
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'
        socket.send_bytes(b'{"type": "heartbeat"}')
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'
        socket.send_json({'type': 'nope'})
        assert socket.receive_json()['code'] == 'UNKNOWN_MESSAGE'
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json() == {'type': 'heartbeat_ack'}


@pytest.mark.asyncio
async def test_revoked_session_closes_socket_on_revalidation(paired, monkeypatch):
    _, device_id, token = paired
    monkeypatch.setattr(channel_module, 'REVALIDATE_SECONDS', 0.05)
    with TestClient(app) as client, board(client, token) as socket:
        async with db.SessionLocal() as session:
            for row in (await session.execute(select(AuthSession).where(AuthSession.device_id == device_id))).scalars():
                row.revoked_at = datetime.now(UTC)
            await session.commit()
        with pytest.raises(WebSocketDisconnect) as info:
            socket.receive_json()
        assert info.value.code == 4401


@pytest.mark.asyncio
async def test_device_revoked_in_database_closes_socket_with_4403(paired, monkeypatch):
    _, device_id, token = paired
    monkeypatch.setattr(channel_module, 'REVALIDATE_SECONDS', 0.05)
    with TestClient(app) as client, board(client, token) as socket:
        async with db.SessionLocal() as session:
            (await session.get(Device, device_id)).revoked_at = datetime.now(UTC)  # bypasses the revoke route and its hub close
            await session.commit()
        with pytest.raises(WebSocketDisconnect) as info:
            socket.receive_json()
        assert info.value.code == 4403


@pytest.mark.asyncio
async def test_access_token_expiry_closes_socket_with_4401(paired):
    _, device_id, _ = paired
    async with db.SessionLocal() as session:
        sid = (await session.execute(select(AuthSession.id).where(AuthSession.device_id == device_id))).scalars().first()
        owner_id = (await session.get(Device, device_id)).owner_id
    short = create_token(owner_id, 'access', 1, device_id, sid)
    with TestClient(app) as client, board(client, short) as socket:
        with pytest.raises(WebSocketDisconnect) as info:
            socket.receive_json()
        assert info.value.code == 4401


@pytest.mark.asyncio
async def test_channel_is_not_shadowed_by_device_routes(paired):
    _, _, token = paired
    with TestClient(app) as client:
        assert client.get(CHANNEL).status_code in (404, 405, 426)  # plain HTTP never reaches a device handler
        with board(client, token):
            pass


@pytest.mark.asyncio
async def test_hung_snapshot_build_releases_the_owner_lock(engine, monkeypatch):
    from app.companion import hub as hub_module
    from app.companion import snapshot as snapshot_module
    local = hub_module.CompanionHub()
    local.debounce = 0
    sent = []

    async def send(message):
        sent.append(message)

    async def hang(*_):
        await asyncio.sleep(3600)
    monkeypatch.setattr(hub_module, 'BUILD_TIMEOUT_SECONDS', 0.05)
    monkeypatch.setattr(snapshot_module, 'build_snapshot', hang)
    local.register('d', 'o', send)
    local.mark_owner_dirty('o')
    await asyncio.wait_for(local.wait_idle(), 2)
    assert sent == [] and not local._owner_locks['o'].locked()


@pytest.mark.asyncio
async def test_revoke_between_auth_and_register_is_caught(paired, monkeypatch):
    _, _, token = paired
    calls = []

    async def late_revoke(*args):
        calls.append(1)
        return None if len(calls) == 1 else 4403  # the second check (right after register) sees the revoke
    monkeypatch.setattr(channel_module, '_validate', late_revoke)
    with TestClient(app) as client, client.websocket_connect(CHANNEL, headers=headers(token)) as socket:
        with pytest.raises(WebSocketDisconnect) as info:
            while True:  # `ready` may or may not get out before the close
                socket.receive_json()
        assert info.value.code == 4403


@pytest.mark.asyncio
async def test_failed_first_snapshot_closes_with_1011(paired, monkeypatch):
    _, _, token = paired

    async def failing(device_id):
        return False
    monkeypatch.setattr(hub, 'push_snapshot', failing)
    with TestClient(app) as client, client.websocket_connect(CHANNEL, headers=headers(token)) as socket:
        assert socket.receive_json()['type'] == 'ready'
        with pytest.raises(WebSocketDisconnect) as info:
            socket.receive_json()
        assert info.value.code == 1011


@pytest.mark.asyncio
async def test_push_snapshot_reports_failure(engine, monkeypatch):
    from app.companion import hub as hub_module
    from app.companion import snapshot as snapshot_module
    local = hub_module.CompanionHub()
    sent = []

    async def send(message):
        sent.append(message)

    async def broken(*_):
        raise RuntimeError('db down')
    assert await local.push_snapshot('nobody') is False
    local.register('d', 'o', send)
    monkeypatch.setattr(snapshot_module, 'build_snapshot', broken)
    assert await local.push_snapshot('d') is False and sent == []


class _Server:
    """A real uvicorn on an ephemeral port: TestClient cannot show what the handshake really does."""

    def __enter__(self):
        import threading

        import uvicorn
        self.server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=0, lifespan='off', log_level='warning'))
        self.thread = threading.Thread(target=lambda: asyncio.run(self.server.serve()), daemon=True)
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started and time.monotonic() < deadline:
            time.sleep(0.02)
        assert self.server.started
        self.port = self.server.servers[0].sockets[0].getsockname()[1]
        return self

    def __exit__(self, *_):
        self.server.should_exit = True
        self.thread.join(10)


async def real_close_code(port, token):
    import websockets
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    async with websockets.connect(f'ws://127.0.0.1:{port}{CHANNEL}', additional_headers=headers) as socket:  # raises if the handshake is rejected
        with pytest.raises(websockets.ConnectionClosed) as info:
            await asyncio.wait_for(socket.recv(), 5)
    return info.value.rcvd.code


@pytest.mark.asyncio
async def test_real_server_delivers_close_codes_after_the_handshake(paired):
    owner, device_id, token = paired
    async with db.SessionLocal() as session:
        sid = (await session.execute(select(AuthSession.id).where(AuthSession.device_id == device_id))).scalars().first()
        owner_id = (await session.get(Device, device_id)).owner_id
    expired = create_token(owner_id, 'access', -10, device_id, sid)
    with _Server() as server:
        assert await real_close_code(server.port, 'garbage') == 4401
        assert await real_close_code(server.port, '') == 4401
        assert await real_close_code(server.port, token[:-2] + 'xx') == 4401
        assert await real_close_code(server.port, owner['access_token']) == 4403  # a macOS device, not a companion
        # An expired token is rejected by decode_token, so exp=-10 never reaches the session lookup.
        assert await real_close_code(server.port, expired) == 4401


@pytest.mark.asyncio
async def test_hello_skips_malformed_pending_entries(paired, caplog):
    _, device_id, token = paired
    good = {'id': str(uuid.uuid4()), 'name': 'ice_update', 'args': {'contacts': [], 'med_note': 'SECRET', 'show_name': False}}
    bad = [{'id': 'c-1', 'name': 'lost_mode', 'args': {}}, {'id': str(uuid.uuid4()), 'name': 'reboot', 'args': {}},
           {'id': str(uuid.uuid4()), 'name': 'lost_mode', 'args': []}, 'junk', {'id': str(uuid.uuid4()), 'name': 'wifi_scan'}]
    async with db.SessionLocal() as session:
        device = await session.get(Device, device_id)
        session.add(CompanionState(device_id=device_id, owner_id=device.owner_id, pending_commands_json=[*bad, good]))
        await session.commit()
    with caplog.at_level('DEBUG'), TestClient(app) as client, board(client, token) as socket:
        socket.send_json({'type': 'hello', 'fw_version': '1', 'board': 'b', 'features': []})
        assert socket.receive_json()['id'] == good['id']
        socket.send_json({'type': 'command_ack', 'id': good['id'], 'ok': True})
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json() == {'type': 'heartbeat_ack'}  # still alive: no reconnect loop
    assert 'SECRET' not in caplog.text
    assert (await state_of(device_id)).pending_commands_json == []  # the ack also swept the junk


@pytest.mark.asyncio
async def test_agents_channel_rejects_a_companion_token(paired):
    _, _, token = paired
    with TestClient(app) as client, pytest.raises(WebSocketDisconnect) as info, client.websocket_connect(f'{B}/agents/channel', headers=headers(token)) as socket:
        socket.receive_json()
    assert info.value.code == 4403
