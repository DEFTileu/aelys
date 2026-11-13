"""The server offers a newer firmware release to a board: after hello, and right after an upload."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest
import pytest_asyncio
from app.companion import firmware as firmware_module
from app.companion.hub import hub, install_change_listeners
from app.companion.models import CompanionState
from app.core import db
from app.core.models import Device, User
from app.main import app
from companion_helpers import B, bearer, companion_token, pair_companion
from firmware_fixtures import make_image, sha256
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient

CHANNEL = f'{B}/devices/channel'
_receiver = ThreadPoolExecutor(max_workers=1)  # TestClient sockets have no receive timeout; a missing frame must fail, not hang


def recv(socket, timeout=5):
    return _receiver.submit(socket.receive_json).result(timeout)


@pytest_asyncio.fixture
async def paired(tmp_path, monkeypatch):
    eng = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/ota_push.db')
    async with eng.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(eng, expire_on_commit=False))
    monkeypatch.setattr(hub, 'debounce', 0.01)
    hub._owner_locks.clear()
    install_change_listeners()
    from httpx import ASGITransport, AsyncClient
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        owner, key, device_id = await pair_companion(client)
        token = await companion_token(client, key, device_id)
    yield owner, device_id, token
    await eng.dispose()


def upload(client, owner, version, min_version='0.0.0'):
    data = make_image(version)
    return client.put(f'{B}/companion/firmware/{version}', params={'min_version': min_version}, content=data,
                      headers={**bearer(owner), 'X-Content-Sha256': sha256(data), 'Content-Type': 'application/octet-stream'})


@contextmanager
def connect(client, token):
    with client.websocket_connect(CHANNEL, headers={'Authorization': f'Bearer {token}'}) as socket:
        assert recv(socket)['type'] == 'ready'
        assert recv(socket)['type'] == 'snapshot'
        yield socket


def hello(socket, version):
    """Send hello, then a heartbeat: frames are handled in order, so everything hello produced precedes the ack."""
    socket.send_json({'type': 'hello', 'fw_version': version, 'board': 'esp32-s3-n16r8', 'features': []})
    socket.send_json({'type': 'heartbeat'})
    frames = []
    while (frame := recv(socket))['type'] != 'heartbeat_ack':
        frames.append(frame)
    return [f for f in frames if f['type'] != 'snapshot']


@pytest.mark.asyncio
async def test_hello_with_old_version_gets_offer(paired):
    owner, _, token = paired
    with TestClient(app) as client:
        assert upload(client, owner, '0.3.0').status_code == 201
        with connect(client, token) as socket:
            assert hello(socket, '0.2.0') == [{'type': 'ota_available', 'version': '0.3.0'}]


@pytest.mark.asyncio
@pytest.mark.parametrize('version', ['0.3.0', '0.9.0', 'garbage'])
async def test_hello_with_current_or_unparseable_version_gets_none(paired, version):
    owner, _, token = paired
    with TestClient(app) as client:
        assert upload(client, owner, '0.3.0').status_code == 201
        with connect(client, token) as socket:
            assert hello(socket, version) == []


@pytest.mark.asyncio
async def test_hello_without_release_gets_none(paired):
    _, _, token = paired
    with TestClient(app) as client, connect(client, token) as socket:
        assert hello(socket, '0.1.0') == []


@pytest.mark.asyncio
async def test_below_min_version_gets_none(paired):
    owner, _, token = paired
    with TestClient(app) as client:
        assert upload(client, owner, '0.3.0', min_version='0.2.0').status_code == 201
        with connect(client, token) as socket:
            assert hello(socket, '0.1.0') == []


@pytest.mark.asyncio
async def test_upload_pushes_to_online_board(paired):
    owner, _, token = paired
    with TestClient(app) as client, connect(client, token) as socket:
        assert hello(socket, '0.2.0') == []
        assert upload(client, owner, '0.3.0').status_code == 201
        # An unrelated snapshot may interleave (the hub pushes them on its own schedule), so skip those only.
        frame = recv(socket)
        while frame['type'] == 'snapshot':
            frame = recv(socket)
        assert frame == {'type': 'ota_available', 'version': '0.3.0'}


@pytest.mark.asyncio
async def test_replayed_upload_pushes_nothing(paired):
    owner, _, token = paired
    with TestClient(app) as client:
        assert upload(client, owner, '0.3.0').status_code == 201
        with connect(client, token) as socket:
            assert hello(socket, '0.2.0') == [{'type': 'ota_available', 'version': '0.3.0'}]
            assert upload(client, owner, '0.3.0').status_code == 200
            socket.send_json({'type': 'heartbeat'})
            frame = recv(socket)
            while frame['type'] == 'snapshot':
                frame = recv(socket)
            assert frame == {'type': 'heartbeat_ack'}


@pytest.mark.asyncio
async def test_metrics_power_fields_stored(paired):
    _, device_id, token = paired
    base = {'type': 'metrics', 'heap_min_internal': 1, 'largest_block': 2, 'psram_free': 3, 'wifi_reconnects': 0, 'uptime_s': 9}
    with TestClient(app) as client, connect(client, token) as socket:
        socket.send_json({**base, 'light_sleep_pct': 42, 'ui_wakes_per_s': 3})
        socket.send_json({'type': 'heartbeat'})
        while recv(socket)['type'] != 'heartbeat_ack':
            pass
        async with db.SessionLocal() as session:
            row = (await session.execute(select(CompanionState).where(CompanionState.device_id == device_id))).scalar_one()
        assert row.last_metrics_json['light_sleep_pct'] == 42 and row.last_metrics_json['ui_wakes_per_s'] == 3
        socket.send_json({**base, 'light_sleep_pct': 101})  # out of range is rejected
        assert recv(socket)['type'] == 'error'


@pytest.mark.asyncio
async def test_failed_offer_lookup_keeps_the_channel_open(paired, monkeypatch):
    _, _, token = paired

    async def boom(*_):
        raise RuntimeError('db down')

    monkeypatch.setattr(firmware_module, 'latest_release', boom)
    with TestClient(app) as client, connect(client, token) as socket:
        assert hello(socket, '0.2.0') == []  # the heartbeat ack arrives: the handler survived


async def fake_online_board(owner_id, fw_version, *, platform='companion'):
    """A board in the hub that is not the test's real one; returns what it was sent."""
    async with db.SessionLocal() as session:
        if not await session.get(User, owner_id):
            session.add(User(id=owner_id))
        device = Device(owner_id=owner_id, platform=platform, display_name='Other', credential_hash='x')
        session.add(device)
        await session.flush()
        session.add(CompanionState(device_id=device.id, owner_id=owner_id, fw_version=fw_version, pending_commands_json=[]))
        await session.commit()
    sent = []

    async def send(message):
        sent.append(message)

    hub.register(device.id, owner_id, send)
    return device.id, sent


@pytest.mark.asyncio
async def test_upload_does_not_reach_another_owners_board(paired):
    owner, _, _ = paired
    _, other_sent = await fake_online_board('00000000-0000-0000-0000-000000000002', '0.1.0')
    with TestClient(app) as client:
        assert upload(client, owner, '0.3.0').status_code == 201
    assert other_sent == []


@pytest.mark.asyncio
async def test_upload_does_not_reach_a_revoked_board(paired):
    owner, device_id, token = paired
    with TestClient(app) as client:
        with connect(client, token) as socket:
            assert hello(socket, '0.1.0') == []
            assert client.post(f'{B}/devices/{device_id}/revoke', headers=bearer(owner)).status_code == 200
        sent = []

        async def send(message):
            sent.append(message)

        hub.register(device_id, 'ignored-by-push', send)  # a socket that outlived the revoke: only the revoked_at filter stops the offer
        assert upload(client, owner, '0.3.0').status_code == 201
    assert sent == []


@pytest.mark.asyncio
async def test_upload_does_not_reach_a_non_companion_device(paired):
    owner, _, _ = paired
    async with db.SessionLocal() as session:
        owner_id = (await session.execute(select(Device.owner_id))).scalars().first()
    _, sent = await fake_online_board(owner_id, '0.1.0', platform='macos')
    with TestClient(app) as client:
        assert upload(client, owner, '0.3.0').status_code == 201
    assert sent == []
