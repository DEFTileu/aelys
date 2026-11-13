"""Protocol v1.1 (plan 3): additive fields, commands and routes on top of the plan-2 companion backend."""
import logging
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from app.companion.hub import hub, install_change_listeners
from app.companion.models import CompanionState
from app.companion.snapshot import build_snapshot
from app.core import db
from app.core.models import Device, Notification, Task, User
from app.main import app
from companion_helpers import B, Key, bearer, companion_token, pair_companion
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

CHANNEL = f'{B}/devices/channel'
HELLO = {'type': 'hello', 'fw_version': '0.5.0', 'board': 'esp32', 'features': []}
LOST_ON = {'on': True, 'message': 'Call me', 'show_phone': True, 'show_telegram': False}


@pytest_asyncio.fixture
async def engine(tmp_path, monkeypatch):
    eng = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/v11.db')
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


def url(device_id, tail=''):
    return f'{B}/companion/devices/{device_id}{tail}'


async def state_of(device_id):
    async with db.SessionLocal() as session:
        return (await session.execute(select(CompanionState).where(CompanionState.device_id == device_id))).scalar_one_or_none()


def reauth(client, owner, owner_key, device_id, context='aelys-companion-unpair-v1'):
    challenge = client.post(f'{B}/auth/device/challenge', json={'device_id': owner['device_id']}).json()
    signature = owner_key.sign(f"{context}\n{device_id}\n{challenge['nonce']}", raw=True)
    return {'challenge_id': challenge['challenge_id'], 'signature': signature}


@pytest.mark.asyncio
async def test_list_companions_owner_only(paired):
    owner, _, _, device_id, token = paired
    async with db.SessionLocal() as session:
        stranger = User(email=None, password_hash=None)
        session.add(stranger)
        await session.flush()
        session.add(Device(owner_id=stranger.id, platform='companion', display_name='Theirs', public_key=Key().public, credential_hash='x'))
        session.add(Device(owner_id=(await session.get(Device, device_id)).owner_id, platform='companion', display_name='Old', public_key=Key().public,
                           credential_hash='x', revoked_at=datetime.now(UTC)))
        await session.commit()
    with TestClient(app) as client:
        listed = client.get(f'{B}/companion/devices', headers=bearer(owner))
        assert listed.status_code == 200
        assert [{**d, 'last_seen_at': bool(d['last_seen_at'])} for d in listed.json()] == [
            {'device_id': device_id, 'display_name': 'Desk', 'online': False, 'last_seen_at': True, 'wifi_current': None, 'battery_pct': None}]
        with board(client, token) as socket:
            socket.send_json(HELLO)
            socket.send_json({'type': 'wifi_state', 'saved': ['Home'], 'current': 'Home'})
            socket.send_json({'type': 'metrics', 'heap_min_internal': 1, 'largest_block': 1, 'psram_free': 1, 'wifi_reconnects': 0, 'uptime_s': 1,
                              'battery_pct': 81, 'charging': True, 'heap_at_connect_min': 5})
            socket.send_json({'type': 'heartbeat'})
            assert socket.receive_json() == {'type': 'heartbeat_ack'}
            row = client.get(f'{B}/companion/devices', headers=bearer(owner)).json()[0]
            assert (row['online'], row['wifi_current'], row['battery_pct']) == (True, 'Home', 81)
            # a board is not an owner: the allow-list and the owner guard both refuse it
            denied = client.get(f'{B}/companion/devices', headers={'Authorization': f'Bearer {token}'})
            assert denied.status_code == 403 and denied.json()['detail']['code'] == 'DEVICE_SCOPE_DENIED'


@pytest.mark.asyncio
async def test_snapshot_today_counts_and_other_unread(engine, paired):
    owner, *_ = paired
    now = datetime(2026, 11, 13, 9, 30, tzinfo=UTC)
    with TestClient(app) as client:
        owner_id = client.get(f'{B}/me', headers=bearer(owner)).json()['id']

    def task(title, hours, status='todo', **extra):
        return Task(owner_id=owner_id, title=title, due_at=now + timedelta(hours=hours), status=status, **extra)
    async with db.SessionLocal() as session:
        session.add_all([task('open', 2), task('open late', 12), task('done', -5, 'done'), task('completed', 1, 'Completed'),
                         task('cancelled', 1, 'cancelled'), task('tomorrow', 20), task('yesterday', -12, 'done'), task('gone', 1, deleted_at=now),
                         Notification(owner_id=owner_id, kind='task.due', title='x'), Notification(owner_id=owner_id, kind='mail.new', title='secret'),
                         Notification(owner_id=owner_id, kind='Task.x', title='y'), Notification(owner_id=owner_id, kind='mail.old', title='z', read_at=now)])
        await session.commit()
        snap = await build_snapshot(session, owner_id, now)
    # due today: open x2 + done x2; cancelled, deleted, yesterday's and tomorrow's tasks are out
    assert (snap.today_done, snap.today_total) == (2, 4)
    assert (snap.unread_count, snap.other_unread_count) == (3, 2)  # 'Task.x' is not an allowed prefix: counted, never named


@pytest.mark.asyncio
async def test_hello_contacts_stored_not_logged(paired, caplog):
    owner, _, _, device_id, token = paired
    contacts = {'phone': '+7 700 123 45 67', 'telegram': '@secret_handle'}
    with caplog.at_level(logging.DEBUG), TestClient(app) as client, board(client, token) as socket:
        socket.send_json({**HELLO, 'contacts': contacts})
        socket.send_json({**HELLO, 'contacts': {'phone': '1' * 24, 'telegram': '@too_long_secret'}})
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json() == {'type': 'heartbeat_ack'}
        assert client.get(url(device_id), headers=bearer(owner)).json()['contacts'] == contacts
        socket.send_json(HELLO)  # a v1 hello keeps what is stored
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json() == {'type': 'heartbeat_ack'}
        assert client.get(url(device_id), headers=bearer(owner)).json()['contacts'] == contacts
    # the app's own loggers; aiosqlite at DEBUG echoes every bound SQL parameter, which only a test ever enables
    logged = ' '.join(r.getMessage() for r in caplog.records if not r.name.startswith(('aiosqlite', 'sqlalchemy', 'httpx')))
    assert '+7 700' not in logged and 'secret_handle' not in logged and 'too_long_secret' not in logged


@pytest.mark.asyncio
async def test_wifi_state_exposed_in_device_state(paired):
    owner, _, _, device_id, token = paired
    with TestClient(app) as client, board(client, token) as socket:
        socket.send_json({'type': 'wifi_state', 'saved': ['Home', 'Work'], 'current': None})
        socket.send_json({'type': 'wifi_state', 'saved': ['x' * 33], 'current': None})
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'
        socket.send_json({'type': 'wifi_state', 'saved': ['a'] * 6, 'current': None})
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'
        socket.send_json({'type': 'metrics', 'heap_min_internal': 1, 'largest_block': 1, 'psram_free': 1, 'wifi_reconnects': 0, 'uptime_s': 1,
                          'battery_pct': 101})
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'
        socket.send_json({'type': 'metrics', 'heap_min_internal': 1, 'largest_block': 1, 'psram_free': 1, 'wifi_reconnects': 0, 'uptime_s': 1,
                          'battery_pct': 40, 'charging': False, 'heap_at_connect_min': 9})
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json() == {'type': 'heartbeat_ack'}
        seen = client.get(url(device_id), headers=bearer(owner)).json()
        assert seen['wifi'] == {'saved': ['Home', 'Work'], 'current': None}
        assert seen['battery'] == {'pct': 40, 'charging': False}
        assert seen['last_metrics']['heap_at_connect_min'] == 9
        assert seen['settings'] is None and seen['command_log'] == [] and seen['contacts'] is None
    assert client.get(url(device_id), headers=bearer(owner)).json()['wifi']['saved'] == ['Home', 'Work']


@pytest.mark.asyncio
async def test_v1_metrics_stay_exact(paired):
    owner, _, _, device_id, token = paired
    v1 = {'heap_min_internal': 1, 'largest_block': 2, 'psram_free': 3, 'wifi_reconnects': 4, 'uptime_s': 5}
    with TestClient(app) as client, board(client, token) as socket:
        socket.send_json({'type': 'metrics', **v1})
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json() == {'type': 'heartbeat_ack'}
        seen = client.get(url(device_id), headers=bearer(owner)).json()
        assert seen['last_metrics'] == v1 and seen['battery'] is None


@pytest.mark.asyncio
async def test_late_ack_recorded(paired):
    owner, _, _, device_id, token = paired
    with TestClient(app) as client:
        with board(client, token) as socket:
            sent = client.post(url(device_id, '/wifi'), json={'blob': 'abc'}, headers=bearer(owner))
            assert sent.status_code == 200
            command = socket.receive_json()
        # the socket is gone before the board could answer; it answers after reconnecting
        log = client.get(url(device_id), headers=bearer(owner)).json()['command_log']
        assert [(e['id'], e['name'], e['ok'], e['error_code']) for e in log] == [(command['id'], 'wifi_add', None, None)]
        assert log[0]['sent_at']
        with board(client, token) as socket:
            socket.send_json({'type': 'command_ack', 'id': command['id'], 'ok': False, 'error_code': 'WIFI_FAILED'})
            socket.send_json({'type': 'command_ack', 'id': str(uuid.uuid4()), 'ok': True})  # unknown id: ignored
            socket.send_json({'type': 'heartbeat'})
            assert socket.receive_json() == {'type': 'heartbeat_ack'}
        log = client.get(url(device_id), headers=bearer(owner)).json()['command_log']
        assert [(e['id'], e['ok'], e['error_code']) for e in log] == [(command['id'], False, 'WIFI_FAILED')]


@pytest.mark.asyncio
async def test_command_log_keeps_ten_expires_after_a_day_and_scan_result_acks(paired):
    owner, _, _, device_id, token = paired
    with TestClient(app) as client, board(client, token) as socket:
        ids = []
        for _ in range(12):
            ids.append(client.post(url(device_id, '/find'), headers=bearer(owner)).json()['id'])
            socket.receive_json()
        scan = client.post(url(device_id, '/wifi-scan'), headers=bearer(owner)).json()['id']
        socket.receive_json()
        socket.send_json({'type': 'wifi_scan_result', 'id': scan, 'networks': []})
        socket.send_json({'type': 'command_ack', 'id': ids[0], 'ok': True})  # fell out of the last 10: nothing to record
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json() == {'type': 'heartbeat_ack'}
        log = client.get(url(device_id), headers=bearer(owner)).json()['command_log']
        assert len(log) == 10 and log[-1]['id'] == scan and log[-1]['ok'] is True and ids[0] not in [e['id'] for e in log]
        # an entry older than 24 h is no longer recorded
        row = await state_of(device_id)
        old = [{**e, 'sent_at': (datetime.now(UTC) - timedelta(hours=25)).isoformat()} if e['id'] == ids[11] else e for e in row.command_log_json]
        async with db.SessionLocal() as session:
            (await session.get(CompanionState, device_id)).command_log_json = old
            await session.commit()
        socket.send_json({'type': 'command_ack', 'id': ids[11], 'ok': True})
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json() == {'type': 'heartbeat_ack'}
        assert [e['ok'] for e in client.get(url(device_id), headers=bearer(owner)).json()['command_log'] if e['id'] == ids[11]] == [None]


@pytest.mark.asyncio
async def test_settings_queued_while_offline_and_deduped(paired):
    owner, _, _, device_id, token = paired
    with TestClient(app) as client:
        put = lambda value: client.put(url(device_id, '/settings'), json={'brightness': value}, headers=bearer(owner))
        assert put(4).status_code == 422 and put(101).status_code == 422
        first = put(30)
        assert first.status_code == 200 and first.json()['delivered'] is False
        second = put(80)
        row = await state_of(device_id)
        assert [(c['name'], c['args']['brightness']) for c in row.pending_commands_json] == [('settings', 80)]
        assert client.get(url(device_id), headers=bearer(owner)).json()['settings'] == {'brightness': 80}
        with board(client, token) as socket:
            socket.send_json(HELLO)
            command = socket.receive_json()
            assert command['id'] == second.json()['id'] and command['name'] == 'settings' and command['args']['brightness'] == 80
            socket.send_json({'type': 'command_ack', 'id': command['id'], 'ok': True})
            socket.send_json({'type': 'heartbeat'})
            assert socket.receive_json() == {'type': 'heartbeat_ack'}
    assert (await state_of(device_id)).pending_commands_json == []


@pytest.mark.asyncio
async def test_restart_offline_is_409(paired):
    owner, _, _, device_id, token = paired
    with TestClient(app) as client:
        for tail, method, body in [('/restart', 'post', None), ('/wifi/remove', 'post', {'ssid': 'Home'}), ('/wifi/order', 'put', {'ssids': ['Home']})]:
            response = getattr(client, method)(url(device_id, tail), headers=bearer(owner), **({'json': body} if body else {}))
            assert response.status_code == 409 and response.json()['detail']['code'] == 'DEVICE_OFFLINE', tail
        assert await state_of(device_id) is None  # never queued, never logged
        with board(client, token) as socket:
            sent = [client.post(url(device_id, '/restart'), headers=bearer(owner)),
                    client.post(url(device_id, '/wifi/remove'), json={'ssid': 'Home'}, headers=bearer(owner)),
                    client.put(url(device_id, '/wifi/order'), json={'ssids': ['Work', 'Home']}, headers=bearer(owner))]
            assert [s.status_code for s in sent] == [200, 200, 200]
            got = [socket.receive_json() for _ in sent]
            assert [(g['name'], g['args'], g['id']) for g in got] == [('restart', {}, sent[0].json()['id']), ('wifi_remove', {'ssid': 'Home'}, sent[1].json()['id']),
                                                                       ('wifi_order', {'ssids': ['Work', 'Home']}, sent[2].json()['id'])]
            assert client.put(url(device_id, '/wifi/order'), json={'ssids': ['a'] * 6}, headers=bearer(owner)).status_code == 422
            assert client.post(url(device_id, '/wifi/remove'), json={'ssid': 'x' * 33}, headers=bearer(owner)).status_code == 422


@pytest.mark.asyncio
async def test_unpair_requires_reauth_sends_command_and_revokes(paired):
    owner, owner_key, _, device_id, token = paired
    with TestClient(app) as client:
        assert client.post(url(device_id, '/unpair'), json={}, headers=bearer(owner)).json()['detail']['code'] == 'REAUTH_REQUIRED'
        wrong_purpose = reauth(client, owner, owner_key, device_id, context='aelys-companion-lost-off-v1')
        assert client.post(url(device_id, '/unpair'), json={'reauth': wrong_purpose}, headers=bearer(owner)).status_code == 403
        assert client.get(url(device_id), headers=bearer(owner)).status_code == 200  # still paired
        with board(client, token) as socket:
            done = client.post(url(device_id, '/unpair'), json={'reauth': reauth(client, owner, owner_key, device_id)}, headers=bearer(owner))
            assert done.status_code == 200 and done.json()['delivered'] is True
            assert socket.receive_json() == {'type': 'command', 'id': done.json()['id'], 'name': 'unpair', 'args': {}}
            with pytest.raises(WebSocketDisconnect) as info:
                socket.receive_json()
            assert info.value.code == 4403
        assert client.get(url(device_id), headers=bearer(owner)).status_code == 404
        reused = client.post(url(device_id, '/unpair'), json={'reauth': reauth(client, owner, owner_key, device_id)}, headers=bearer(owner))
        assert reused.status_code == 404


@pytest.mark.asyncio
async def test_unpair_offline_still_revokes(paired):
    owner, owner_key, _, device_id, _ = paired
    with TestClient(app) as client:
        done = client.post(url(device_id, '/unpair'), json={'reauth': reauth(client, owner, owner_key, device_id)}, headers=bearer(owner))
        assert done.status_code == 200 and done.json()['delivered'] is False
        assert client.get(url(device_id), headers=bearer(owner)).status_code == 404
    async with db.SessionLocal() as session:
        assert (await session.get(Device, device_id)).revoked_at is not None


@pytest.mark.asyncio
async def test_v1_ice_args_still_accepted(paired):
    owner, _, _, device_id, _ = paired
    v1 = {'contacts': [{'name': 'Mom', 'phone': '+7 700 000 00 00'}], 'med_note': 'Allergy', 'show_name': True}
    with TestClient(app) as client:
        assert client.put(url(device_id, '/ice'), json=v1, headers=bearer(owner)).status_code == 200
        ice = client.get(url(device_id), headers=bearer(owner)).json()['ice']
        assert ice['contacts'] == [{'name': 'Mom', 'relation': '', 'phone': '+7 700 000 00 00'}]
        assert (ice['owner_name'], ice['show_contacts'], ice['show_med'], ice['show_name'], ice['rev']) == ('', True, True, True, 1)
        v11 = {**v1, 'owner_name': 'Aelys', 'show_contacts': False, 'show_med': False, 'contacts': [{'name': 'Mom', 'relation': 'mother', 'phone': '1'}]}
        assert client.put(url(device_id, '/ice'), json=v11, headers=bearer(owner)).status_code == 200
        assert client.get(url(device_id), headers=bearer(owner)).json()['ice']['contacts'][0]['relation'] == 'mother'
        for bad in ({'owner_name': 'x' * 33}, {'contacts': [{'name': 'a', 'relation': 'x' * 17, 'phone': '1'}]}):
            assert client.put(url(device_id, '/ice'), json={**v1, **bad}, headers=bearer(owner)).status_code == 422


@pytest.mark.asyncio
async def test_lost_mode_v11_args_and_server_set_since(paired):
    owner, owner_key, _, device_id, _ = paired
    with TestClient(app) as client:
        v1 = client.put(url(device_id, '/lost-mode'), json=LOST_ON, headers=bearer(owner))
        assert v1.status_code == 200
        args = client.get(url(device_id), headers=bearer(owner)).json()['lost_mode']
        assert (args['show_email'], args['email'], args['qr'], args['rev']) == (False, None, 'telegram', 1) and args['since']
        first_since = args['since']
        again = {**LOST_ON, 'show_email': True, 'email': 'me@example.com', 'qr': 'phone', 'since': '2001-01-01T00:00:00Z'}  # since is server-set: ignored
        assert client.put(url(device_id, '/lost-mode'), json=again, headers=bearer(owner)).status_code == 200
        args = client.get(url(device_id), headers=bearer(owner)).json()['lost_mode']
        assert (args['show_email'], args['email'], args['qr'], args['since']) == (True, 'me@example.com', 'phone', first_since)
        for bad in ({'email': 'x' * 49}, {'qr': 'sms'}):
            assert client.put(url(device_id, '/lost-mode'), json={**LOST_ON, **bad}, headers=bearer(owner)).status_code == 422
        off = {'on': False, 'message': '', 'show_phone': False, 'show_telegram': False, 'reauth': reauth(client, owner, owner_key, device_id, 'aelys-companion-lost-off-v1')}
        assert client.put(url(device_id, '/lost-mode'), json=off, headers=bearer(owner)).status_code == 200
        assert 'since' not in client.get(url(device_id), headers=bearer(owner)).json()['lost_mode']
        client.put(url(device_id, '/lost-mode'), json=LOST_ON, headers=bearer(owner))
        assert client.get(url(device_id), headers=bearer(owner)).json()['lost_mode']['since'] >= first_since
