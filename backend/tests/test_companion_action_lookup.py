import asyncio
import json
import uuid
from contextlib import suppress
from datetime import UTC, datetime

import pytest
from app.ai.errors import PolicyDenied
from app.ai.policy import ServerPolicyEngine
from app.companion import channel
from app.companion.actions import ActionIn, run_action
from app.companion.models import CompanionAction, CompanionState
from app.core import db
from app.core.models import Device, User
from app.core.security import decode_token
from app.main import app
from sqlalchemy import func, select
from starlette.testclient import TestClient
from test_companion_channel import (
    board,
    engine,  # noqa: F401
)
from test_companion_channel import paired as paired_fixture  # noqa: F401


async def link_for(token):
    claims = decode_token(token)
    replies, closed = [], []

    async def reply(value):
        replies.append(value)

    async def close(value):
        closed.append(value)

    return channel._Link(claims['device_id'], claims['sub'], reply, close,
                         session_id=claims['sid'], token_exp=claims['exp']), replies, closed


async def lookup(link, action_id):
    await channel._dispatch(link, json.dumps({'type': 'action_lookup', 'id': action_id}))


@pytest.mark.asyncio
async def test_lookup_socket_returns_receipts_and_unknown_without_writes(paired_fixture):  # noqa: F811
    _, device_id, token = paired_fixture
    action_id, missing = str(uuid.uuid4()), str(uuid.uuid4())
    with TestClient(app) as client, board(client, token) as socket:
        socket.send_json({'type': 'action', 'id': action_id, 'kind': 'focus.pause', 'payload': {}})
        assert socket.receive_json()['error_code'] == 'NO_ACTIVE_FOCUS'
        for requested, expected in [(action_id, {'type': 'action_lookup_result', 'id': action_id, 'found': True, 'ok': False, 'error_code': 'NO_ACTIVE_FOCUS'}),
                                    (action_id, {'type': 'action_lookup_result', 'id': action_id, 'found': True, 'ok': False, 'error_code': 'NO_ACTIVE_FOCUS'}),
                                    (missing, {'type': 'action_lookup_result', 'id': missing, 'found': False}),
                                    (action_id.upper(), {'type': 'action_lookup_result', 'id': action_id.upper(), 'found': True, 'ok': False, 'error_code': 'NO_ACTIVE_FOCUS'})]:
            socket.send_json({'type': 'action_lookup', 'id': requested})
            assert socket.receive_json() == expected
        socket.send_json({'type': 'action_lookup', 'id': 'invalid'})
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'
        socket.send_json({'type': 'future_frame'})
        assert socket.receive_json()['code'] == 'UNKNOWN_MESSAGE'
    async with db.SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(CompanionAction).where(CompanionAction.device_id == device_id)) == 1


@pytest.mark.asyncio
async def test_lookup_scoped_to_current_owner_and_device(paired_fixture):  # noqa: F811
    _, device_id, token = paired_fixture
    link, replies, _ = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        device = await session.get(Device, device_id)
        other = User(email='lookup-other@example.com')
        session.add(other)
        await session.flush()
        second = Device(owner_id=device.owner_id, platform='companion', display_name='second', credential_hash='x')
        foreign = Device(owner_id=other.id, platform='companion', display_name='foreign', credential_hash='x')
        session.add_all([second, foreign])
        await session.flush()
        for target in (second, foreign):
            session.add(CompanionAction(id=action_id, owner_id=target.owner_id, device_id=target.id,
                                        kind='focus.pause', result_json={'ok': True, 'error_code': None}))
        await session.commit()
    await lookup(link, action_id)
    assert replies == [{'type': 'action_lookup_result', 'id': action_id, 'found': False}]


@pytest.mark.asyncio
async def test_lookup_hides_receipt_in_lost_mode_and_when_policy_denies(paired_fixture, monkeypatch):  # noqa: F811
    _, device_id, token = paired_fixture
    link, replies, _ = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        device = await session.get(Device, device_id)
        owner_id = device.owner_id
        result = await run_action(session, owner_id, device, ActionIn(id=action_id, kind='focus.pause'))
        assert result.error_code == 'NO_ACTIVE_FOCUS'
        state = await session.get(CompanionState, device_id)
        if state is None:
            state = CompanionState(device_id=device_id, owner_id=owner_id, pending_commands_json=[])
            session.add(state)
        state.lost_mode_json = {'on': True}
        await session.commit()
    await lookup(link, action_id)
    assert replies.pop() == {'type': 'action_lookup_result', 'id': action_id, 'found': False}
    async with db.SessionLocal() as session:
        (await session.get(CompanionState, device_id)).lost_mode_json = {'on': False}
        await session.commit()
    def deny(self, tool, call, context):
        raise PolicyDenied('denied')
    monkeypatch.setattr(ServerPolicyEngine, 'authorize', deny)
    await lookup(link, action_id)
    assert replies.pop() == {'type': 'action_lookup_result', 'id': action_id, 'found': False}


@pytest.mark.asyncio
async def test_lookup_does_not_expose_receipt_after_session_revocation(paired_fixture):  # noqa: F811
    from app.core.models import AuthSession
    _, _, token = paired_fixture
    link, replies, closed = await link_for(token)
    async with db.SessionLocal() as session:
        (await session.get(AuthSession, link.session_id)).revoked_at = datetime.now(UTC)
        await session.commit()
    await lookup(link, str(uuid.uuid4()))
    assert replies == [] and closed == [channel.AUTH_CLOSE_CODE]


@pytest.mark.asyncio
async def test_lookup_sees_only_committed_inflight_receipt(paired_fixture):  # noqa: F811
    _, device_id, token = paired_fixture
    link, replies, _ = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as writer:
        device = await writer.get(Device, device_id)
        writer.add(CompanionAction(id=action_id, owner_id=device.owner_id, device_id=device_id,
                                   kind='focus.pause', result_json={'ok': False, 'error_code': 'NO_ACTIVE_FOCUS'}))
        await writer.flush()
        await asyncio.wait_for(lookup(link, action_id), 2)
        assert replies.pop() == {'type': 'action_lookup_result', 'id': action_id, 'found': False}
        await writer.commit()
    await lookup(link, action_id)
    assert replies.pop() == {'type': 'action_lookup_result', 'id': action_id, 'found': True, 'ok': False, 'error_code': 'NO_ACTIVE_FOCUS'}


@pytest.mark.asyncio
async def test_ready_advertises_action_lookup(paired_fixture):  # noqa: F811
    _, device_id, token = paired_fixture
    from test_companion_channel import CHANNEL, headers
    with TestClient(app) as client, client.websocket_connect(CHANNEL, headers=headers(token)) as socket:
        assert socket.receive_json() == {'type': 'ready', 'device_id': device_id, 'capabilities': ['action_lookup']}


@pytest.mark.asyncio
async def test_lookup_success_does_not_repeat_action(paired_fixture):  # noqa: F811
    from app.core.models import Notification
    _, device_id, token = paired_fixture
    link, replies, _ = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        device = await session.get(Device, device_id)
        item = Notification(owner_id=device.owner_id, kind='task.due', title='lookup')
        session.add(item)
        await session.commit()
        item_id = item.id
        result = await run_action(session, device.owner_id, device, ActionIn(
            id=action_id, kind='notification.read', payload={'notification_id': item_id}))
        assert result.ok
    async with db.SessionLocal() as session:
        (await session.get(Notification, item_id)).read_at = None
        await session.commit()
    await lookup(link, action_id)
    assert replies == [{'type': 'action_lookup_result', 'id': action_id, 'found': True, 'ok': True}]
    async with db.SessionLocal() as session:
        assert (await session.get(Notification, item_id)).read_at is None


@pytest.mark.asyncio
@pytest.mark.parametrize('result', [None, [], {}, {'ok': 'true'}, {'ok': 1},
                                   {'ok': False, 'error_code': 5},
                                   {'ok': True, 'error_code': 'SECRET'},
                                   {'ok': False, 'error_code': 'x' * 41},
                                   {'ok': False, 'error_code': 'BAD\nSECRET'},
                                   {'ok': False, 'error_code': 'PRIVATE_ACCOUNT_NAME'},
                                   {'ok': False, 'extra': 'secret'}])
async def test_lookup_hides_malformed_receipt(paired_fixture, result):  # noqa: F811
    _, device_id, token = paired_fixture
    link, replies, _ = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        device = await session.get(Device, device_id)
        session.add(CompanionAction(id=action_id, owner_id=device.owner_id, device_id=device_id,
                                    kind='focus.pause', result_json=result))
        await session.commit()
    await lookup(link, action_id)
    assert replies == [{'type': 'action_lookup_result', 'id': action_id, 'found': False}]


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['lost', 'device', 'session'])
async def test_lookup_delayed_writer_rechecks_lifecycle(paired_fixture, monkeypatch, change):  # noqa: F811
    import threading

    from app.core.models import AuthSession
    from starlette.websockets import WebSocket, WebSocketDisconnect
    from test_companion_channel import CHANNEL, headers

    _, device_id, token = paired_fixture
    claims = decode_token(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        session.add(CompanionAction(id=action_id, owner_id=claims['sub'], device_id=device_id,
                                    kind='focus.pause', result_json={'ok': False, 'error_code': 'NO_ACTIVE_FOCUS'}))
        await session.commit()
    writer_waiting, release, queued = threading.Event(), threading.Event(), threading.Event()
    original_send, original_handler = WebSocket.send_json, channel.HANDLERS['action_lookup']

    async def delayed_send(socket, data, *args, **kwargs):
        if data.get('type') == 'heartbeat_ack':
            writer_waiting.set()
            await asyncio.to_thread(release.wait)
        return await original_send(socket, data, *args, **kwargs)

    async def observed_lookup(link, message):
        await original_handler(link, message)
        queued.set()

    monkeypatch.setattr(WebSocket, 'send_json', delayed_send)
    monkeypatch.setitem(channel.HANDLERS, 'action_lookup', observed_lookup)
    try:
        with TestClient(app) as client, client.websocket_connect(CHANNEL, headers=headers(token)) as socket:
            assert socket.receive_json()['type'] == 'ready'
            assert socket.receive_json()['type'] == 'snapshot'
            socket.send_json({'type': 'heartbeat'})
            assert await asyncio.to_thread(writer_waiting.wait, 5)
            socket.send_json({'type': 'action_lookup', 'id': action_id})
            assert await asyncio.to_thread(queued.wait, 5)
            async with db.SessionLocal() as session:
                if change == 'lost':
                    state = await session.get(CompanionState, device_id)
                    state.lost_mode_json = {'on': True}
                elif change == 'device':
                    (await session.get(Device, device_id)).revoked_at = datetime.now(UTC)
                else:
                    (await session.get(AuthSession, claims['sid'])).revoked_at = datetime.now(UTC)
                await session.commit()
            release.set()
            assert socket.receive_json()['type'] == 'heartbeat_ack'
            if change == 'lost':
                assert socket.receive_json() == {'type': 'action_lookup_result', 'id': action_id, 'found': False}
            else:
                with pytest.raises(WebSocketDisconnect) as exc:
                    socket.receive_json()
                assert exc.value.code == (channel.DEVICE_CLOSE_CODE if change == 'device' else channel.AUTH_CLOSE_CODE)
    finally:
        release.set()


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['lost', 'device', 'session'])
async def test_lookup_holds_lifecycle_fence_through_send(paired_fixture, change):  # noqa: F811
    from app.companion.state import locked_state
    from app.core.models import AuthSession

    _, device_id, token = paired_fixture
    link, replies, _ = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        session.add(CompanionAction(id=action_id, owner_id=link.owner_id, device_id=device_id,
                                    kind='focus.pause', result_json={'ok': True, 'error_code': None}))
        await session.commit()
    sending, release = asyncio.Event(), asyncio.Event()
    original_reply = link.reply

    async def delayed_reply(message):
        sending.set()
        await release.wait()
        await original_reply(message)

    async def change_lifecycle():
        async with db.SessionLocal() as session:
            if change == 'lost':
                state = await locked_state(session, device_id, link.owner_id)
                state.lost_mode_json = {'on': True}
            elif change == 'device':
                (await session.get(Device, device_id)).revoked_at = datetime.now(UTC)
            else:
                (await session.get(AuthSession, link.session_id)).revoked_at = datetime.now(UTC)
            await session.commit()

    link.reply = delayed_reply
    delivery = asyncio.create_task(lookup(link, action_id))
    mutation = None
    try:
        await asyncio.wait_for(sending.wait(), 5)
        mutation = asyncio.create_task(change_lifecycle())
        done, _ = await asyncio.wait({mutation}, timeout=0.2)
        assert not done, 'lifecycle change committed before socket send completed'
    finally:
        release.set()
        await asyncio.wait_for(delivery, 5)
        if mutation:
            await asyncio.wait_for(mutation, 5)
    assert replies == [{'type': 'action_lookup_result', 'id': action_id, 'found': True, 'ok': True}]


from test_companion_postgres import postgres  # noqa: F401


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['lost', 'device', 'session'])
async def test_postgres_lookup_writer_fences_lifecycle(postgres, change):  # noqa: F811
    from app.companion.state import locked_state
    from app.core.models import AuthSession
    from companion_helpers import companion_token, pair_companion
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        _, key, device_id = await pair_companion(http)
        token = await companion_token(http, key, device_id)
    link, replies, closed = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        session.add(CompanionAction(id=action_id, owner_id=link.owner_id, device_id=device_id,
                                    kind='focus.pause', result_json={'ok': False, 'error_code': 'NO_ACTIVE_FOCUS'}))
        await session.commit()

    async def change_lifecycle():
        async with db.SessionLocal() as session:
            if change == 'lost':
                state = await locked_state(session, device_id, link.owner_id)
                state.lost_mode_json = {'on': True}
            elif change == 'device':
                (await session.get(Device, device_id)).revoked_at = datetime.now(UTC)
            else:
                (await session.get(AuthSession, link.session_id)).revoked_at = datetime.now(UTC)
            await session.commit()

    # The writer's callback has been queued, but has not inspected the receipt.
    queued = []
    async def enqueue(deliver):
        queued.append(deliver)
    link.enqueue_lookup = enqueue
    await lookup(link, action_id)
    assert len(queued) == 1

    # Start the actual send, and verify the lifecycle update cannot commit
    # while the writer holds the fence (including a previously absent state row).
    sending, release = asyncio.Event(), asyncio.Event()
    async def delayed_reply(message):
        sending.set()
        await release.wait()
        replies.append(message)
    link.direct_reply = delayed_reply
    delivery = asyncio.create_task(queued.pop()())
    mutation = None
    try:
        await asyncio.wait_for(sending.wait(), 5)
        mutation = asyncio.create_task(change_lifecycle())
        done, _ = await asyncio.wait({mutation}, timeout=0.2)
        assert not done
    finally:
        release.set()
        await asyncio.wait_for(delivery, 5)
        if mutation:
            await asyncio.wait_for(mutation, 5)
    assert replies == [{'type': 'action_lookup_result', 'id': action_id, 'found': True,
                        'ok': False, 'error_code': 'NO_ACTIVE_FOCUS'}]

    # A lookup queued before the lifecycle update must recheck at delivery.
    replies.clear()
    await lookup(link, action_id)
    await queued.pop()()
    if change == 'lost':
        assert replies == [{'type': 'action_lookup_result', 'id': action_id, 'found': False}]
    else:
        assert replies == []
        assert closed == [channel.DEVICE_CLOSE_CODE if change == 'device' else channel.AUTH_CLOSE_CODE]


@pytest.mark.asyncio
async def test_stalled_lookup_send_times_out_releases_lock_and_closes_socket(paired_fixture, monkeypatch):  # noqa: F811
    import threading

    from app.companion.state import locked_state
    from starlette.websockets import WebSocket, WebSocketDisconnect
    from test_companion_channel import CHANNEL, headers

    _, device_id, token = paired_fixture
    owner_id = decode_token(token)['sub']
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        session.add(CompanionAction(id=action_id, owner_id=owner_id, device_id=device_id,
                                    kind='focus.pause', result_json={'ok': True, 'error_code': None}))
        await session.commit()
    started = threading.Event()
    original_send = WebSocket.send_json

    async def stalled_send(socket, message, *args, **kwargs):
        if message.get('type') == 'action_lookup_result':
            started.set()
            await asyncio.Event().wait()
        await original_send(socket, message, *args, **kwargs)

    monkeypatch.setattr(channel, 'LOOKUP_SEND_TIMEOUT_SECONDS', 0.3, raising=False)
    monkeypatch.setattr(WebSocket, 'send_json', stalled_send)
    with TestClient(app) as client, client.websocket_connect(CHANNEL, headers=headers(token)) as socket:
        assert socket.receive_json()['type'] == 'ready'
        assert socket.receive_json()['type'] == 'snapshot'
        socket.send_json({'type': 'action_lookup', 'id': action_id})
        assert await asyncio.to_thread(started.wait, 5)

        async def set_lost():
            async with db.SessionLocal() as session:
                state = await locked_state(session, device_id, owner_id)
                state.lost_mode_json = {'on': True}
                await session.commit()

        change = asyncio.create_task(set_lost())
        try:
            await asyncio.wait_for(asyncio.shield(change), 2)
            with pytest.raises(WebSocketDisconnect) as exc:
                socket.receive_json()
            assert exc.value.code == channel.ERROR_CLOSE_CODE
        finally:
            if not change.done():
                change.cancel()
                with suppress(asyncio.CancelledError):
                    await change


@pytest.mark.asyncio
async def test_postgres_stalled_lookup_releases_lifecycle_lock(postgres, monkeypatch):  # noqa: F811
    from app.companion.state import locked_state
    from companion_helpers import companion_token, pair_companion
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        _, key, device_id = await pair_companion(http)
        token = await companion_token(http, key, device_id)
    link, replies, _ = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        session.add(CompanionAction(id=action_id, owner_id=link.owner_id, device_id=device_id,
                                    kind='focus.pause', result_json={'ok': True, 'error_code': None}))
        await session.commit()
    started = asyncio.Event()

    async def stalled_send(_message):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(channel, 'LOOKUP_SEND_TIMEOUT_SECONDS', 0.2)
    link.reply = stalled_send
    delivery = asyncio.create_task(lookup(link, action_id))
    mutation = None
    try:
        await asyncio.wait_for(started.wait(), 5)

        async def set_lost():
            async with db.SessionLocal() as session:
                state = await locked_state(session, device_id, link.owner_id)
                state.lost_mode_json = {'on': True}
                await session.commit()

        mutation = asyncio.create_task(set_lost())
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(delivery, 2)
        await asyncio.wait_for(mutation, 2)
        assert replies == []
    finally:
        for task in (delivery, mutation):
            if task and not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task


@pytest.mark.asyncio
async def test_lookup_does_not_write_database(paired_fixture, engine):  # noqa: F811
    from sqlalchemy import event

    _, device_id, token = paired_fixture
    link, replies, _ = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        session.add(CompanionAction(id=action_id, owner_id=link.owner_id, device_id=device_id,
                                    kind='focus.pause', result_json={'ok': True, 'error_code': None}))
        await session.commit()
    writes = []

    def record_writes(_connection, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().split(None, 1)[0].upper() in {'INSERT', 'UPDATE', 'DELETE', 'REPLACE'}:
            writes.append(statement)

    event.listen(engine.sync_engine, 'before_cursor_execute', record_writes)
    try:
        await lookup(link, action_id)
        await lookup(link, str(uuid.uuid4()))
    finally:
        event.remove(engine.sync_engine, 'before_cursor_execute', record_writes)
    assert replies[0]['found'] is True and replies[1]['found'] is False
    assert writes == []


@pytest.mark.asyncio
async def test_lookup_timeout_fails_closed_if_send_suppresses_cancellation(paired_fixture, monkeypatch):  # noqa: F811
    _, device_id, token = paired_fixture
    link, replies, _ = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        session.add(CompanionAction(id=action_id, owner_id=link.owner_id, device_id=device_id,
                                    kind='focus.pause', result_json={'ok': True, 'error_code': None}))
        await session.commit()

    async def stalled_send(_message):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            return

    monkeypatch.setattr(channel, 'LOOKUP_SEND_TIMEOUT_SECONDS', 0.05)
    link.reply = stalled_send
    with pytest.raises(TimeoutError):
        await lookup(link, action_id)
    assert replies == []


@pytest.mark.asyncio
async def test_missing_lookup_send_is_bounded(paired_fixture, monkeypatch):  # noqa: F811
    _, _, token = paired_fixture
    link, _, _ = await link_for(token)
    attempted = asyncio.Event()

    async def stalled_send(_message):
        attempted.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(channel, 'LOOKUP_SEND_TIMEOUT_SECONDS', 0.05)
    link.reply = stalled_send
    with pytest.raises(TimeoutError):
        await lookup(link, str(uuid.uuid4()))
    assert attempted.is_set()


@pytest.mark.asyncio
async def test_postgres_lookup_lock_timeout_releases_revocation(postgres, monkeypatch):  # noqa: F811
    from app.core.models import AuthSession
    from companion_helpers import companion_token, pair_companion
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        _, key, device_id = await pair_companion(http)
        token = await companion_token(http, key, device_id)
    link, replies, _ = await link_for(token)
    action_id = str(uuid.uuid4())
    async with db.SessionLocal() as session:
        session.add_all([
            CompanionAction(id=action_id, owner_id=link.owner_id, device_id=device_id,
                            kind='focus.pause', result_json={'ok': True, 'error_code': None}),
            CompanionState(device_id=device_id, owner_id=link.owner_id, pending_commands_json=[]),
        ])
        await session.commit()
    monkeypatch.setattr(channel, 'LOOKUP_SEND_TIMEOUT_SECONDS', 0.2)
    async with db.SessionLocal() as holder:
        await holder.get(CompanionState, device_id, with_for_update=True)
        delivery = asyncio.create_task(lookup(link, action_id))
        await asyncio.sleep(0.1)
        async def revoke():
            async with db.SessionLocal() as session:
                (await session.get(AuthSession, link.session_id)).revoked_at = datetime.now(UTC)
                await session.commit()
        mutation = asyncio.create_task(revoke())
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(delivery, 3)
        await asyncio.wait_for(mutation, 3)
        assert replies == []
