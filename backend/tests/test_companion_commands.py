import logging
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from app.companion import channel as channel_module
from app.companion.hub import hub, install_change_listeners
from app.companion.models import CompanionState
from app.companion.state import valid_command
from app.core import db
from app.core.models import Device, Notification, Task, User
from app.main import app
from companion_helpers import B, Key, b64, bearer, companion_token, pair_companion
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient

CHANNEL = f'{B}/devices/channel'
LOST_ON = {'on': True, 'message': 'Call me', 'show_phone': True, 'show_telegram': False}
LOST_V11 = {'show_email': False, 'email': None, 'qr': 'telegram'}  # defaults v1.1 adds to a v1 request
HELLO = {'type': 'hello', 'fw_version': '0.4.1', 'board': 'esp32', 'features': []}
BLOB = 'q2V5ZGF0YS1lbmNyeXB0ZWQ' + 'ZZtopSecretBlobPart'


@pytest_asyncio.fixture
async def engine(tmp_path, monkeypatch):
    eng = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/commands.db')
    async with eng.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(eng, expire_on_commit=False))
    monkeypatch.setattr(hub, 'debounce', 0.01)
    hub._owner_locks.clear()
    install_change_listeners()
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def paired(engine):
    """Owner session, the owner's key, board key, board device id and a board access token."""
    from httpx import ASGITransport, AsyncClient
    owner_key = Key()
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        owner, board_key, device_id = await pair_companion(client, owner_key)
        token = await companion_token(client, board_key, device_id)
    return owner, owner_key, board_key, device_id, token


@contextmanager
def board(client, token):
    with client.websocket_connect(CHANNEL, headers={'Authorization': f'Bearer {token}'}) as socket:
        assert socket.receive_json()['type'] == 'ready'
        assert socket.receive_json()['type'] == 'snapshot'
        yield socket


async def state_of(device_id):
    async with db.SessionLocal() as session:
        return (await session.execute(select(CompanionState).where(CompanionState.device_id == device_id))).scalar_one_or_none()


def url(device_id, tail=''):
    return f'{B}/companion/devices/{device_id}{tail}'


def lost_off(client, owner, owner_key, device_id, target=None, sign_for=None):
    challenge = client.post(f'{B}/auth/device/challenge', json={'device_id': owner['device_id']}).json()
    message = f"aelys-companion-lost-off-v1\n{sign_for or device_id}\n{challenge['nonce']}"
    return {'on': False, 'message': '', 'show_phone': False, 'show_telegram': False,
            'reauth': {'challenge_id': challenge['challenge_id'], 'signature': owner_key.sign(message, raw=True)}}


@pytest.mark.asyncio
async def test_lost_mode_on_while_offline_is_delivered_on_connect(paired):
    owner, _, _, device_id, token = paired
    with TestClient(app) as client:
        sent = client.put(url(device_id, '/lost-mode'), json=LOST_ON, headers=bearer(owner))
        assert sent.status_code == 200 and sent.json()['delivered'] is False
        newer = client.put(url(device_id, '/lost-mode'), json={**LOST_ON, 'message': 'Newer'}, headers=bearer(owner))
        row = await state_of(device_id)
        assert [c['name'] for c in row.pending_commands_json] == ['lost_mode'] and row.lost_mode_json['message'] == 'Newer'
        with board(client, token) as socket:
            socket.send_json(HELLO)
            command = socket.receive_json()
            assert command['args'].pop('since')  # server-set, v1.1
            assert command == {'type': 'command', 'id': newer.json()['id'], 'name': 'lost_mode', 'args': {**LOST_ON, **LOST_V11, 'message': 'Newer', 'rev': 2}}
            socket.send_json({'type': 'command_ack', 'id': command['id'], 'ok': True})
            socket.send_json({'type': 'heartbeat'})
            assert socket.receive_json() == {'type': 'heartbeat_ack'}
    assert (await state_of(device_id)).pending_commands_json == []


@pytest.mark.asyncio
async def test_online_lost_mode_and_ice_go_out_at_once_and_stay_pending_until_acked(paired):
    owner, _, _, device_id, token = paired
    ice = {'contacts': [{'name': 'Mom', 'phone': '+7 700 000 00 00'}], 'med_note': 'Allergy', 'show_name': True}
    with TestClient(app) as client, board(client, token) as socket:
        assert client.put(url(device_id, '/lost-mode'), json=LOST_ON, headers=bearer(owner)).json()['delivered'] is True
        lost = socket.receive_json()
        assert lost['args'].pop('since')
        assert (lost['name'], lost['args']) == ('lost_mode', {**LOST_ON, **LOST_V11, 'rev': 1})
        assert socket.receive_json()['type'] == 'snapshot'  # the gate changed, so the board is re-pushed
        assert client.put(url(device_id, '/ice'), json=ice, headers=bearer(owner)).status_code == 200
        assert (socket.receive_json()['name'], ) == ('ice_update',)
    row = await state_of(device_id)
    v11 = {'owner_name': '', 'show_contacts': True, 'show_med': True, 'contacts': [{'name': 'Mom', 'relation': '', 'phone': '+7 700 000 00 00'}]}
    assert row.ice_json == {**ice, **v11, 'rev': 1} and sorted(c['name'] for c in row.pending_commands_json) == ['ice_update', 'lost_mode']


@pytest.mark.asyncio
async def test_lost_mode_hides_server_data_and_denies_actions_until_turned_off(paired):
    owner, owner_key, _, device_id, token = paired
    headers = {'Authorization': f'Bearer {token}'}
    with TestClient(app) as client:
        owner_id = client.get(f'{B}/me', headers=bearer(owner)).json()['id']
        async with db.SessionLocal() as session:
            note = Notification(owner_id=owner_id, kind='task.due', title='Pay rent')
            session.add_all([note, Task(owner_id=owner_id, title='Report', due_at=datetime.now(UTC) + timedelta(hours=3), status='todo'),
                             Task(owner_id=owner_id, title='Late', due_at=datetime.now(UTC) - timedelta(hours=3), status='todo')])
            await session.commit()
            note_id = note.id
        normal = client.get(f'{B}/companion/snapshot', headers=headers).json()
        assert normal['next_task']['title'] == 'Report' and normal['overdue_count'] == 1 and normal['unread_count'] == 1 and len(normal['notices']) == 1
        assert [t['title'] for t in normal['tasks_today']] == ['Report', 'Late']  # lists reach the board; gone in lost mode

        with board(client, token) as socket:
            assert client.put(url(device_id, '/lost-mode'), json=LOST_ON, headers=bearer(owner)).json()['delivered'] is True
            assert socket.receive_json()['name'] == 'lost_mode'
            pushed = socket.receive_json()
            assert pushed['type'] == 'snapshot'
            redacted = pushed['snapshot']
            assert (redacted['next_task'], redacted['next_event'], redacted['notices'], redacted['focus'], redacted['overdue_count']) == (None, None, [], None, 0)
            assert redacted['unread_count'] == 1 and redacted['generated_at'] and redacted['tasks_today'] == [] and redacted['events_upcoming'] == []
            got = client.get(f'{B}/companion/snapshot', headers=headers).json()
            assert got['next_task'] is None and got['notices'] == [] and got['unread_count'] == 1
            act = {'id': str(uuid.uuid4()), 'kind': 'notification.read', 'payload': {'notification_id': note_id}}
            assert client.post(f'{B}/companion/actions', headers=headers, json=act).json() == {'id': act['id'], 'ok': False, 'error_code': 'POLICY_DENIED'}
            socket.send_json({'type': 'action', 'id': str(uuid.uuid4()), 'kind': 'nonsense', 'payload': {}})
            assert socket.receive_json()['error_code'] == 'POLICY_DENIED'  # denied before dispatch, even for an unknown kind
            async with db.SessionLocal() as session:
                assert (await session.get(Notification, note_id)).read_at is None

            off = lost_off(client, owner, owner_key, device_id)
            assert client.put(url(device_id, '/lost-mode'), json=off, headers=bearer(owner)).status_code == 200
            assert socket.receive_json()['name'] == 'lost_mode'
            restored = socket.receive_json()['snapshot']
            assert restored['next_task']['title'] == 'Report' and restored['overdue_count'] == 1 and len(restored['notices']) == 1
            assert client.get(f'{B}/companion/snapshot', headers=headers).json()['next_task']['title'] == 'Report'
            again = {'id': str(uuid.uuid4()), 'kind': 'notification.read', 'payload': {'notification_id': note_id}}
            assert client.post(f'{B}/companion/actions', headers=headers, json=again).json()['ok'] is True


@pytest.mark.asyncio
async def test_initial_channel_snapshot_is_redacted_while_lost(paired):
    owner, _, _, device_id, token = paired
    with TestClient(app) as client:
        owner_id = client.get(f'{B}/me', headers=bearer(owner)).json()['id']
        async with db.SessionLocal() as session:
            session.add(Task(owner_id=owner_id, title='Report', due_at=datetime.now(UTC) + timedelta(hours=3), status='todo'))
            await session.commit()
        assert client.put(url(device_id, '/lost-mode'), json=LOST_ON, headers=bearer(owner)).json()['delivered'] is False
        with client.websocket_connect(CHANNEL, headers={'Authorization': f'Bearer {token}'}) as socket:
            assert socket.receive_json()['type'] == 'ready'
            first = socket.receive_json()
            assert first['type'] == 'snapshot' and first['snapshot']['next_task'] is None


@pytest.mark.asyncio
async def test_lost_mode_off_requires_fresh_reauth(paired):
    owner, owner_key, _, device_id, _ = paired
    off = {'on': False, 'message': '', 'show_phone': False, 'show_telegram': False}
    with TestClient(app) as client:
        missing = client.put(url(device_id, '/lost-mode'), json=off, headers=bearer(owner))
        assert missing.status_code == 403 and missing.json()['detail']['code'] == 'REAUTH_REQUIRED'
        valid = lost_off(client, owner, owner_key, device_id)
        assert client.put(url(device_id, '/lost-mode'), json=valid, headers=bearer(owner)).status_code == 200
        reused = client.put(url(device_id, '/lost-mode'), json=valid, headers=bearer(owner))
        assert reused.status_code == 403 and reused.json()['detail']['code'] == 'REAUTH_REQUIRED'
        wrong_target = client.put(url(device_id, '/lost-mode'), json=lost_off(client, owner, owner_key, device_id, sign_for='other'), headers=bearer(owner))
        assert wrong_target.status_code == 403
        wrong_key = lost_off(client, owner, Key(), device_id)
        assert client.put(url(device_id, '/lost-mode'), json=wrong_key, headers=bearer(owner)).status_code == 403
        # Burned by the failed attempt: the right signature on the same challenge no longer works.
        assert client.put(url(device_id, '/lost-mode'), json=wrong_key, headers=bearer(owner)).status_code == 403
        # A challenge issued for another device is not the caller's.
        foreign = client.post(f'{B}/auth/device/challenge', json={'device_id': device_id}).json()
        sig = Key().sign(f"aelys-companion-lost-off-v1\n{device_id}\n{foreign['nonce']}", raw=True)
        assert client.put(url(device_id, '/lost-mode'), json={**off, 'reauth': {'challenge_id': foreign['challenge_id'], 'signature': sig}}, headers=bearer(owner)).status_code == 403
    assert (await state_of(device_id)).lost_mode_json['on'] is False


@pytest.mark.asyncio
async def test_find_offline_is_409(paired):
    owner, _, _, device_id, token = paired
    with TestClient(app) as client:
        offline = client.post(url(device_id, '/find'), headers=bearer(owner))
        assert offline.status_code == 409 and offline.json()['detail']['code'] == 'DEVICE_OFFLINE'
        assert client.post(url(device_id, '/wifi-scan'), headers=bearer(owner)).status_code == 409
        assert client.post(url(device_id, '/wifi'), json={'blob': 'abc'}, headers=bearer(owner)).status_code == 409
        assert await state_of(device_id) is None  # never queued
        with board(client, token) as socket:
            found = client.post(url(device_id, '/find'), headers=bearer(owner))
            assert found.status_code == 200
            assert socket.receive_json() == {'type': 'command', 'id': found.json()['id'], 'name': 'play_sound', 'args': {}}
            scan = client.post(url(device_id, '/wifi-scan'), headers=bearer(owner))
            assert socket.receive_json()['name'] == 'wifi_scan'
            socket.send_json({'type': 'wifi_scan_result', 'id': scan.json()['id'], 'networks': [{'ssid': 'Home', 'rssi': -40, 'secure': True}]})
            socket.send_json({'type': 'heartbeat'})
            assert socket.receive_json() == {'type': 'heartbeat_ack'}
            seen = client.get(url(device_id), headers=bearer(owner)).json()
            assert seen['last_wifi_scan']['networks'][0]['ssid'] == 'Home'


@pytest.mark.asyncio
async def test_wifi_blob_is_forwarded_not_stored_or_logged(paired, caplog):
    owner, _, _, device_id, token = paired
    with caplog.at_level(logging.DEBUG), TestClient(app) as client, board(client, token) as socket:
        sent = client.post(url(device_id, '/wifi'), json={'blob': BLOB}, headers=bearer(owner))
        assert sent.status_code == 200
        assert socket.receive_json() == {'type': 'command', 'id': sent.json()['id'], 'name': 'wifi_add', 'args': {'blob': BLOB}}
        assert client.post(url(device_id, '/wifi'), json={'blob': b64(bytes(513))}, headers=bearer(owner)).status_code == 422
        rejected = client.post(url(device_id, '/wifi'), json={'blob': 'ZZtopSecretBlobPart not base64!'}, headers=bearer(owner))
        assert rejected.status_code == 422 and 'ZZtopSecretBlobPart' not in rejected.text  # the 422 body must not echo the blob
        assert rejected.json() == {'detail': {'code': 'VALIDATION_ERROR', 'message': 'Invalid request'}}
        assert client.post(url(device_id, '/wifi'), json={'blob': b64(bytes(512))}, headers=bearer(owner)).status_code == 200
    assert 'ZZtopSecretBlobPart' not in caplog.text and BLOB not in caplog.text
    row = await state_of(device_id)
    assert row is None or 'ZZtopSecretBlobPart' not in repr(row.__dict__)
    async with db.SessionLocal() as session:  # and nowhere else in the database
        for table in db.Base.metadata.sorted_tables:
            for values in (await session.execute(table.select())).all():
                assert 'ZZtopSecretBlobPart' not in repr(values)


@pytest.mark.asyncio
async def test_board_cannot_call_owner_commands(paired):
    _, _, _, device_id, token = paired
    headers = {'Authorization': f'Bearer {token}'}
    with TestClient(app) as client:
        for method, tail, body in [('get', '', None), ('put', '/lost-mode', LOST_ON), ('put', '/ice', {'contacts': []}),
                                   ('post', '/find', None), ('post', '/wifi', {'blob': 'abc'}), ('post', '/wifi-scan', None)]:
            response = getattr(client, method)(url(device_id, tail), headers=headers, **({'json': body} if body else {}))
            assert response.status_code == 403 and response.json()['detail']['code'] == 'DEVICE_SCOPE_DENIED', (method, tail)


@pytest.mark.asyncio
async def test_other_owner_device_is_404(paired):
    owner, _, _, device_id, _ = paired
    async with db.SessionLocal() as session:
        stranger = User(email=None, password_hash=None)
        session.add(stranger)
        await session.flush()
        foreign = Device(owner_id=stranger.id, platform='companion', display_name='X', public_key=Key().public, credential_hash='x')
        session.add(foreign)
        await session.commit()
        foreign_id = foreign.id
    with TestClient(app) as client:
        for target in (foreign_id, str(uuid.uuid4()), owner['device_id']):  # foreign board, nothing, the owner's own Mac
            assert client.get(url(target), headers=bearer(owner)).status_code == 404
            assert client.post(url(target, '/find'), headers=bearer(owner)).status_code == 404
            assert client.put(url(target, '/ice'), json={'contacts': []}, headers=bearer(owner)).status_code == 404
        assert client.post(f'{B}/devices/{device_id}/revoke', headers=bearer(owner)).status_code == 200
        assert client.get(url(device_id), headers=bearer(owner)).status_code == 404  # revoked boards are gone


@pytest.mark.asyncio
async def test_state_exposes_public_key(paired):
    owner, _, board_key, device_id, token = paired
    with TestClient(app) as client:
        offline = client.get(url(device_id), headers=bearer(owner)).json()
        assert offline['public_key'] == board_key.public and offline['online'] is False and offline['lost_mode'] is None
        with board(client, token) as socket:
            socket.send_json(HELLO)
            socket.send_json({'type': 'heartbeat'})
            assert socket.receive_json() == {'type': 'heartbeat_ack'}
            online = client.get(url(device_id), headers=bearer(owner)).json()
            assert online['online'] is True and online['fw_version'] == '0.4.1' and online['display_name'] == 'Desk'


@pytest.mark.asyncio
async def test_size_limits_are_422(paired):
    owner, _, _, device_id, _ = paired
    contact = {'name': 'a', 'phone': '1'}
    with TestClient(app) as client:
        put = lambda path, body: client.put(url(device_id, path), json=body, headers=bearer(owner)).status_code
        assert put('/lost-mode', {**LOST_ON, 'message': 'x' * 65}) == 422
        assert put('/ice', {'contacts': [contact] * 3}) == 422
        assert put('/ice', {'contacts': [{'name': 'x' * 33, 'phone': '1'}]}) == 422
        assert put('/ice', {'contacts': [{'name': 'a', 'phone': '1' * 24}]}) == 422
        assert put('/ice', {'contacts': [], 'med_note': 'x' * 97}) == 422
        assert put('/ice', {'contacts': [contact] * 2, 'med_note': 'x' * 96}) == 200


def test_pending_entry_shape():
    ok = {'id': str(uuid.uuid4()), 'name': 'lost_mode', 'args': {}}
    assert valid_command(ok)
    for bad in [{**ok, 'id': 'c-1'}, {**ok, 'id': str(uuid.uuid1())}, {**ok, 'name': 'reboot'}, {**ok, 'args': []},
                {**ok, 'extra': 1}, {'id': ok['id'], 'name': 'lost_mode'}, 'x', None]:
        assert not valid_command(bad)


@pytest.mark.asyncio
async def test_revs_increase_and_state_exposes_them(paired):
    owner, _, _, device_id, _ = paired
    with TestClient(app) as client:
        assert client.get(url(device_id), headers=bearer(owner)).json()['lost_mode'] is None
        for expected in (1, 2, 3):
            assert client.put(url(device_id, '/lost-mode'), json=LOST_ON, headers=bearer(owner)).status_code == 200
            assert client.get(url(device_id), headers=bearer(owner)).json()['lost_mode']['rev'] == expected
        assert client.put(url(device_id, '/ice'), json={'contacts': []}, headers=bearer(owner)).status_code == 200  # per name
        state = client.get(url(device_id), headers=bearer(owner)).json()
        assert (state['lost_mode']['rev'], state['ice']['rev']) == (3, 1)
        assert [c['args']['rev'] for c in (await state_of(device_id)).pending_commands_json] == [3, 1]


@pytest.mark.asyncio
async def test_hello_flush_racing_a_put_delivers_revs_in_order_of_state(paired):
    """_hello read pending [A] and committed, then a PUT stores and sends B, then _hello flushes the stale A."""
    from httpx import ASGITransport, AsyncClient
    owner, _, _, device_id, _ = paired
    received = []

    async def send(message):
        received.append(message)

    async def close(code):
        pass

    async with db.SessionLocal() as session:
        owner_id = (await session.get(Device, device_id)).owner_id
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        assert (await http.put(url(device_id, '/lost-mode'), json={**LOST_ON, 'message': 'A'}, headers=bearer(owner))).status_code == 200
        unregister = hub.register(device_id, owner_id, send, close)
        flushed = False

        async def reply(message):
            nonlocal flushed
            if not flushed:  # the first flushed command: the PUT lands between _hello's commit and its sends
                flushed = True
                put = await http.put(url(device_id, '/lost-mode'), json={**LOST_ON, 'message': 'B'}, headers=bearer(owner))
                assert put.status_code == 200
            received.append(message)

        try:
            await channel_module._hello(channel_module._Link(device_id, owner_id, reply, close), HELLO)
        finally:
            unregister()
    received = [m for m in received if m['type'] == 'command']  # lost-mode PUTs also push a snapshot
    assert [m['args']['message'] for m in received] == ['B', 'A']  # B overtook A on the wire...
    assert [m['args']['rev'] for m in received] == [2, 1]  # ...but the board can tell: 2 > 1, so it keeps B
    assert [c['args']['message'] for c in (await state_of(device_id)).pending_commands_json] == ['B']


@pytest.mark.asyncio
async def test_busy_ack_keeps_the_command_other_failures_drop_it(paired):
    owner, _, _, device_id, token = paired
    with TestClient(app) as client:
        client.put(url(device_id, '/lost-mode'), json=LOST_ON, headers=bearer(owner))
        client.put(url(device_id, '/ice'), json={'contacts': []}, headers=bearer(owner))
        pending = {c['name']: c['id'] for c in (await state_of(device_id)).pending_commands_json}
        with board(client, token) as socket:
            socket.send_json({'type': 'command_ack', 'id': pending['lost_mode'], 'ok': False, 'error_code': 'BUSY'})
            socket.send_json({'type': 'command_ack', 'id': pending['ice_update'], 'ok': False, 'error_code': 'BAD_ARGS'})
            socket.send_json({'type': 'heartbeat'})
            assert socket.receive_json() == {'type': 'heartbeat_ack'}
    assert [c['name'] for c in (await state_of(device_id)).pending_commands_json] == ['lost_mode']
