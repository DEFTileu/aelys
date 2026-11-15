import asyncio

import pytest
from app.companion import channel


@pytest.mark.asyncio
async def test_voice_start_dispatch_and_audio_limit(monkeypatch):
    sent = []
    async def reply(message):
        sent.append(message)
    async def close(code):
        pass
    async def allowed(link):
        return True
    monkeypatch.setattr(channel, '_voice_allowed', allowed)
    link = channel._Link('device', 'owner', reply, close)
    await channel._dispatch(link, '{"type":"voice_start","id":"one","rate":16000,"format":"pcm_s16le","speak":false}')
    await channel._audio(link, b'x' * 640001)
    assert sent[-1]['error_code'] == 'VOICE_TOO_LONG'
    assert link.voice is None


@pytest.mark.asyncio
async def test_second_start_cancels_prior_turn(monkeypatch):
    sent = []
    stopped = asyncio.Event()
    async def reply(message):
        sent.append(message)
    async def close(code):
        pass
    async def allowed(link):
        return True
    async def turn(*args, **kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
    monkeypatch.setattr(channel, '_voice_allowed', allowed)
    monkeypatch.setattr(channel, 'run_voice_turn', turn)
    link = channel._Link('device', 'owner', reply, close)
    start = {'type': 'voice_start', 'id': 'one', 'rate': 16000, 'format': 'pcm_s16le', 'speak': False}
    await channel._voice_start(link, start)
    await channel._voice_end(link, {'id': 'one'})
    await asyncio.sleep(0)
    await channel._voice_start(link, {**start, 'id': 'two'})
    await asyncio.wait_for(stopped.wait(), 1)
    assert link.voice.id == 'two'

import threading

from app.companion.models import CompanionState
from app.core import db
from app.main import app
from starlette.testclient import TestClient
from test_companion_channel import board

pytest_plugins = ('test_companion_channel',)


def start(socket, ident):
    socket.send_json({'type': 'voice_start', 'id': ident, 'rate': 16000, 'format': 'pcm_s16le', 'speak': True})


@pytest.mark.asyncio
async def test_websocket_voice_roundtrip_and_binary_without_start(paired, monkeypatch):
    _, _, token = paired
    async def turn(owner, device, ident, pcm, speak, send, audio, **kwargs):
        assert pcm == b'\x01\x02'
        await send({'type': 'voice_text', 'id': ident, 'text': 'hello'})
        await audio(b'\x03\x04')
    monkeypatch.setattr(channel, 'run_voice_turn', turn)
    with TestClient(app) as client, board(client, token) as socket:
        socket.send_bytes(b'ignored')
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json()['type'] == 'heartbeat_ack'
        start(socket, 'one')
        socket.send_bytes(b'\x01\x02')
        socket.send_json({'type': 'voice_end', 'id': 'one'})
        assert socket.receive_json() == {'type': 'voice_text', 'id': 'one', 'text': 'hello'}
        assert socket.receive_bytes() == b'\x03\x04'


@pytest.mark.asyncio
async def test_websocket_disconnect_cancels_turn(paired, monkeypatch):
    _, _, token = paired
    started, stopped = threading.Event(), threading.Event()
    async def turn(*args, **kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
    monkeypatch.setattr(channel, 'run_voice_turn', turn)
    with TestClient(app) as client:
        with board(client, token) as socket:
            start(socket, 'one')
            socket.send_json({'type': 'voice_end', 'id': 'one'})
            assert started.wait(2)
        assert stopped.wait(2)


@pytest.mark.asyncio
async def test_websocket_lost_mode_refuses_and_text_limit(paired):
    _, device_id, token = paired
    with TestClient(app) as client, board(client, token) as socket:
        async with db.SessionLocal() as session:
            state = await session.get(CompanionState, device_id)
            state.lost_mode_json = {'on': True}
            await session.commit()
        start(socket, 'one')
        assert socket.receive_json()['error_code'] == 'VOICE_UNAVAILABLE'
        socket.send_text('x' * 4097)
        assert socket.receive_json()['code'] == 'VALIDATION_ERROR'


@pytest.mark.asyncio
async def test_websocket_new_start_cancels_old_and_fences_output(paired, monkeypatch):
    _, _, token = paired
    started = threading.Event()
    async def turn(owner, device, ident, pcm, speak, send, audio, **kwargs):
        if ident == 'old':
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await send({'type': 'voice_text', 'id': 'old', 'text': 'stale'})
                await audio(b'old!')
                raise
        await send({'type': 'voice_text', 'id': ident, 'text': 'fresh'})
    monkeypatch.setattr(channel, 'run_voice_turn', turn)
    with TestClient(app) as client, board(client, token) as socket:
        start(socket, 'old')
        socket.send_json({'type': 'voice_end', 'id': 'old'})
        assert started.wait(2)
        start(socket, 'new')
        socket.send_json({'type': 'voice_end', 'id': 'new'})
        assert socket.receive_json() == {'type': 'voice_text', 'id': 'new', 'text': 'fresh'}
        socket.send_json({'type': 'heartbeat'})
        assert socket.receive_json()['type'] == 'heartbeat_ack'
