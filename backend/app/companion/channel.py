"""WebSocket device channel for the desk board; the wire contract is docs/companion-protocol.md.

Tasks per socket: a reader (board frames), a writer (the only code that sends; replies and hub pushes share one
queue so they stay ordered), a supervisor that revalidates the device and session, and a waiter that ends the
handler as soon as anyone (hub, supervisor, handler) closes the socket. No database session lives across the
loop: every message opens a short one.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any

from app.companion.actions import ActionIn, run_action
from app.companion.character import REACTION_REASONS, CharacterStateIn
from app.companion.hub import hub
from app.companion.models import CompanionState
from app.companion.state import locked_state, record_ack, valid_command
from app.companion.voice import VOICE_MAX_BYTES, run_voice_turn
from app.core import db as core_db
from app.core.models import AuthSession, Device
from app.core.security import decode_token
from fastapi import APIRouter, WebSocket
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import update

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_FRAME_BYTES = 4096
REVALIDATE_SECONDS = 60.0  # tests shrink this
OUTBOX_SIZE = 64
AUTH_CLOSE_CODE = 4401
DEVICE_CLOSE_CODE = 4403
ERROR_CLOSE_CODE = 1011


class HelloContacts(BaseModel):
    phone: str = Field(default="", max_length=23)
    telegram: str = Field(default="", max_length=32)


class HelloIn(BaseModel):
    fw_version: str = Field(max_length=40)
    board: str = Field(max_length=60)
    contacts: HelloContacts | None = None  # v1.1; personal data: stored for the owner, never logged


class MetricsIn(BaseModel):
    heap_min_internal: int = Field(ge=0)
    largest_block: int = Field(ge=0)
    psram_free: int = Field(ge=0)
    wifi_reconnects: int = Field(ge=0)
    uptime_s: int = Field(ge=0)
    battery_pct: int | None = Field(default=None, ge=0, le=100)  # v1.1, optional
    charging: bool | None = None
    heap_at_connect_min: int | None = Field(default=None, ge=0)


class CommandAckIn(BaseModel):
    id: str = Field(max_length=64)
    ok: bool
    error_code: str | None = Field(default=None, max_length=40)


class Network(BaseModel):
    ssid: str = Field(max_length=32)
    rssi: int
    secure: bool


class WifiScanResultIn(BaseModel):
    id: str = Field(max_length=64)
    networks: list[Network] = Field(max_length=64)


class WifiStateIn(BaseModel):
    saved: list[Annotated[str, Field(max_length=32)]] = Field(max_length=5)
    current: str | None = Field(default=None, max_length=32)


@dataclass
class _Voice:
    id: str
    speak: bool
    buf: bytearray | None
    task: asyncio.Task | None = None


@dataclass
class _Link:
    device_id: str
    owner_id: str
    reply: Callable[[dict], Awaitable[None]]
    close: Callable[[int], Awaitable[None]]
    session_id: str | None = None
    character_epoch: int | None = None
    token_exp: int | None = None
    voice: _Voice | None = None
    voice_output: Callable[[dict | bytes, _Voice], Awaitable[None]] | None = None
    voice_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


async def _begin_character_session(link: _Link) -> int:
    async with core_db.SessionLocal() as db:
        row = await locked_state(db, link.device_id, link.owner_id)
        row.character_epoch += 1
        row.character_seq = -1
        await db.commit()
        return row.character_epoch


async def _character_state(link: _Link, message: dict) -> None:
    body = CharacterStateIn.model_validate(message)
    close_code = None
    async with core_db.SessionLocal() as db:
        device = await db.get(Device, link.device_id, with_for_update=True)
        session = await db.get(AuthSession, link.session_id, with_for_update=True) if link.session_id else None
        if (not session or session.revoked_at or session.owner_id != link.owner_id or
                session.device_id != link.device_id or _expired(session.expires_at) or
                (link.token_exp is not None and time.time() >= link.token_exp)):
            close_code = AUTH_CLOSE_CODE
        elif not device or device.revoked_at or device.platform != 'companion' or device.owner_id != link.owner_id:
            close_code = DEVICE_CLOSE_CODE
        else:
            row = await locked_state(db, link.device_id, link.owner_id)
            lost = row.lost_mode_json or {}
            if (link.character_epoch is None or row.character_epoch != link.character_epoch or
                    body.seq <= row.character_seq or lost.get('on') or body.lost_rev != lost.get('rev', 0)):
                return
            observed = {'mood': body.mood, 'reason': body.reason, 'reported_at': datetime.now(UTC).isoformat()}
            previous = row.character_json if isinstance(row.character_json, dict) else {}
            recent = observed if body.reason in REACTION_REASONS else previous.get('recent')
            row.character_json = {'current': observed, 'recent': recent}
            row.character_seq = body.seq
            await db.commit()
    if close_code is not None:
        await link.close(close_code)



async def _hello(link: _Link, message: dict) -> None:
    body = HelloIn.model_validate(message)
    async with core_db.SessionLocal() as db:
        row = await locked_state(db, link.device_id, link.owner_id)
        row.fw_version, row.board, row.last_hello_at = body.fw_version, body.board, datetime.now(UTC)
        if body.contacts is not None:  # a v1 hello keeps what is stored
            row.contacts_json = body.contacts.model_dump()
        pending = list(row.pending_commands_json or [])
        await db.commit()
    for command in pending:  # kept until the board acks them
        if not valid_command(command):
            logger.warning("companion skipped a malformed pending command device=%s", link.device_id)
            continue
        await link.reply({"type": "command", "id": command["id"], "name": command["name"], "args": command["args"]})


async def _heartbeat(link: _Link, message: dict) -> None:
    async with core_db.SessionLocal() as db:
        await db.execute(update(Device).where(Device.id == link.device_id).values(last_seen_at=datetime.now(UTC)))
        await db.commit()
    await link.reply({"type": "heartbeat_ack"})


async def _metrics(link: _Link, message: dict) -> None:
    body = MetricsIn.model_validate(message)
    async with core_db.SessionLocal() as db:
        (await locked_state(db, link.device_id, link.owner_id)).last_metrics_json = body.model_dump(exclude_none=True)
        await db.commit()


async def _command_ack(link: _Link, message: dict) -> None:
    body = CommandAckIn.model_validate(message)
    async with core_db.SessionLocal() as db:
        row = await locked_state(db, link.device_id, link.owner_id)
        # A new list: JSON columns don't track in-place edits.
        # BUSY keeps the command for the next hello. Malformed leftovers always go: they could never be delivered.
        retry = not body.ok and body.error_code == "BUSY"
        row.pending_commands_json = [c for c in row.pending_commands_json or [] if valid_command(c) and (retry or c["id"] != body.id)]
        record_ack(row, body.id, body.ok, body.error_code)  # also for commands that were never queued, and for late acks
        await db.commit()


async def _wifi_scan_result(link: _Link, message: dict) -> None:
    body = WifiScanResultIn.model_validate(message)
    async with core_db.SessionLocal() as db:
        # The result is the wifi_scan command's ack; wifi_scan is never queued, so nothing is left to drop.
        row = await locked_state(db, link.device_id, link.owner_id)
        row.last_wifi_scan_json = {**body.model_dump(), "received_at": datetime.now(UTC).isoformat()}
        record_ack(row, body.id, True, None)
        await db.commit()


async def _wifi_state(link: _Link, message: dict) -> None:
    body = WifiStateIn.model_validate(message)
    async with core_db.SessionLocal() as db:
        (await locked_state(db, link.device_id, link.owner_id)).wifi_json = body.model_dump()
        await db.commit()


async def _action(link: _Link, message: dict) -> None:
    body = ActionIn.model_validate(message)
    async with core_db.SessionLocal() as db:
        device = await db.get(Device, link.device_id)
        if device is None or device.revoked_at:
            await link.close(DEVICE_CLOSE_CODE)
            return
        result = await run_action(db, link.owner_id, device, body)
    await link.reply({"type": "action_result", **result.model_dump(mode="json", exclude_none=True)})


class VoiceStartIn(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    rate: int
    format: str
    speak: bool


class VoiceIdIn(BaseModel):
    id: str = Field(min_length=1, max_length=40)


async def _voice_allowed(link: _Link) -> bool:
    try:
        if not link.session_id or await _validate(link.owner_id, link.device_id, link.session_id) is not None:
            return False
        if link.token_exp is not None and time.time() >= link.token_exp:
            return False
        async with core_db.SessionLocal() as db:
            row = await db.get(CompanionState, link.device_id)
            if not row or row.owner_id != link.owner_id:
                return False
            lost = row.lost_mode_json
            return lost is None or (isinstance(lost, dict) and lost.get('on') is False)
    except Exception:  # noqa: BLE001 - authorization must fail closed
        return False


def _cancel_voice(link: _Link) -> None:
    old, link.voice = link.voice, None
    if old and old.task and not old.task.done():
        old.task.cancel()


async def _voice_start(link: _Link, message: dict) -> None:
    body = VoiceStartIn.model_validate(message)
    if body.rate != 16000 or body.format != 'pcm_s16le':
        raise ValueError('invalid voice format')
    async with link.voice_lock:
        _cancel_voice(link)
    if not await _voice_allowed(link):
        await link.reply({'type': 'voice_state', 'id': body.id, 'state': 'error', 'error_code': 'VOICE_UNAVAILABLE'})
        return
    link.voice = _Voice(body.id, body.speak, bytearray())


async def _audio(link: _Link, data: bytes) -> None:
    voice = link.voice
    if not voice or voice.buf is None:
        return
    if len(voice.buf) + len(data) > VOICE_MAX_BYTES:
        link.voice = None
        await link.reply({'type': 'voice_state', 'id': voice.id, 'state': 'error', 'error_code': 'VOICE_TOO_LONG'})
        return
    voice.buf.extend(data)


async def _voice_end(link: _Link, message: dict) -> None:
    body = VoiceIdIn.model_validate(message)
    voice = link.voice
    if not voice or voice.id != body.id or voice.buf is None:
        return
    pcm, voice.buf = bytes(voice.buf), None
    async def output(item: dict | bytes) -> None:
        if link.voice is not voice or not await _voice_allowed(link):
            return
        if link.voice_output:
            await link.voice_output(item, voice)
        elif isinstance(item, dict):
            await link.reply(item)
    async def authorized(db) -> bool:
        if link.voice is not voice or not link.session_id or (link.token_exp is not None and time.time() >= link.token_exp):
            return False
        session = await db.get(AuthSession, link.session_id, with_for_update=True, populate_existing=True)
        return bool(session and not session.revoked_at and session.owner_id == link.owner_id and
                    session.device_id == link.device_id and not _expired(session.expires_at) and link.voice is voice)
    voice.task = asyncio.create_task(run_voice_turn(link.owner_id, link.device_id, voice.id, pcm, voice.speak, output, output, authorized=authorized))


async def _voice_cancel(link: _Link, message: dict) -> None:
    body = VoiceIdIn.model_validate(message)
    if link.voice and link.voice.id == body.id:
        async with link.voice_lock:
            _cancel_voice(link)


HANDLERS: dict[str, Callable[[_Link, dict], Awaitable[None]]] = {
    "hello": _hello, "heartbeat": _heartbeat, "metrics": _metrics, "action": _action,
    "command_ack": _command_ack, "wifi_scan_result": _wifi_scan_result, "wifi_state": _wifi_state,
    "character_state": _character_state, "voice_start": _voice_start, "voice_end": _voice_end, "voice_cancel": _voice_cancel}


def _error(code: str, message: str) -> dict:
    return {"type": "error", "code": code, "message": message}


async def _dispatch(link: _Link, text: str | None) -> None:
    if text is None or len(text.encode()) > MAX_FRAME_BYTES:
        await link.reply(_error("VALIDATION_ERROR", "frame must be a text frame of at most 4 KB"))
        return
    try:
        message = json.loads(text)
    except ValueError:
        message = None
    if not isinstance(message, dict) or not isinstance(message.get("type"), str):
        await link.reply(_error("VALIDATION_ERROR", "frame must be a JSON object with a string type"))
        return
    handler = HANDLERS.get(message["type"])
    if handler is None:
        await link.reply(_error("UNKNOWN_MESSAGE", "unknown message type"))
        return
    try:
        await handler(link, message)
    except (ValidationError, ValueError):
        await link.reply(_error("VALIDATION_ERROR", "invalid message"))


def _expired(moment: datetime) -> bool:
    return (moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment) <= datetime.now(UTC)  # SQLite returns naive values


async def _validate(owner_id: str, device_id: str, session_id: str) -> int | None:
    """Close code for a credential that is no longer good, else None."""
    async with core_db.SessionLocal() as db:
        device = await db.get(Device, device_id)
        session = await db.get(AuthSession, session_id)
    if not session or session.revoked_at or session.owner_id != owner_id or session.device_id != device_id or _expired(session.expires_at):
        return AUTH_CLOSE_CODE
    if not device or device.revoked_at or device.platform != "companion" or device.owner_id != owner_id:
        return DEVICE_CLOSE_CODE
    return None


async def _supervise(link: _Link, session_id: str, token_exp: int) -> None:
    while True:
        await asyncio.sleep(max(0.0, min(REVALIDATE_SECONDS, token_exp - time.time())))
        code = AUTH_CLOSE_CODE if time.time() >= token_exp else await _validate(link.owner_id, link.device_id, session_id)
        if code is not None:
            await link.close(code)
            return


async def _reject(websocket: WebSocket, code: int) -> None:
    """Accept, then close: a close before the handshake becomes a bare HTTP 403 under uvicorn and the board never sees the code."""
    await websocket.accept()
    await websocket.close(code=code)


@router.websocket("/devices/channel")
async def device_channel(websocket: WebSocket) -> None:
    authorization = websocket.headers.get("authorization")
    token = authorization.split(" ", 1)[1] if authorization and authorization.lower().startswith("bearer ") else ""
    try:
        claims = decode_token(token)
        owner_id, device_id, session_id = claims.get("sub"), claims.get("device_id"), claims.get("sid")
        if claims.get("typ") != "access" or not owner_id or not device_id or not session_id:
            raise ValueError("device session access token required")
    except Exception:  # noqa: BLE001 - untrusted credentials fail closed
        await _reject(websocket, AUTH_CLOSE_CODE)
        return
    if (code := await _validate(owner_id, device_id, session_id)) is not None:
        await _reject(websocket, code)
        return

    await websocket.accept()
    outbox: asyncio.Queue[tuple[dict | bytes, asyncio.Future[None] | None, _Voice | None]] = asyncio.Queue(OUTBOX_SIZE)
    ended = asyncio.Event()  # the writer is gone: nothing queued from now on would ever be sent
    gone = asyncio.Event()  # somebody closed the socket

    async def reply(message: dict) -> None:
        if ended.is_set():
            raise ConnectionError("channel closed")
        await outbox.put((message, None, None))

    async def push(message: dict) -> None:
        """The hub's send: resolves only once the frame has really gone out, so a dead socket is noticed."""
        if ended.is_set():
            raise ConnectionError("channel closed")
        sent: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        await outbox.put((message, sent, None))
        await sent

    async def voice_output(message: dict | bytes, voice: _Voice) -> None:
        if ended.is_set():
            raise ConnectionError("channel closed")
        await outbox.put((message, None, voice))

    async def close(code: int) -> None:
        if gone.is_set():
            return
        gone.set()
        with suppress(Exception):  # the peer may already be gone
            await websocket.close(code=code)

    async def writer() -> None:
        try:
            while True:
                message, sent, voice = await outbox.get()
                try:
                    if voice is not None:
                        async with link.voice_lock, core_db.SessionLocal() as db:
                            device = await db.get(Device, link.device_id, with_for_update=True, populate_existing=True)
                            state = await locked_state(db, link.device_id, link.owner_id)
                            session = await db.get(AuthSession, link.session_id, with_for_update=True, populate_existing=True)
                            lost = state.lost_mode_json if state else True
                            allowed = (device and device.owner_id == link.owner_id and device.platform == 'companion' and not device.revoked_at
                                and session and not session.revoked_at and session.owner_id == link.owner_id and session.device_id == link.device_id
                                and not _expired(session.expires_at) and link.token_exp is not None and time.time() < link.token_exp and state and state.owner_id == link.owner_id
                                and (lost is None or (isinstance(lost, dict) and lost.get('on') is False)))
                            if not allowed or link.voice is not voice:
                                continue
                            async with asyncio.timeout(5):
                                if isinstance(message, bytes):
                                    await websocket.send_bytes(message)
                                else:
                                    await websocket.send_json(message)
                    elif isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_json(message)
                except BaseException as exc:  # cancellation too: the hub must not wait out its send timeout under the owner lock
                    if sent and not sent.done():
                        sent.set_exception(exc if isinstance(exc, Exception) else ConnectionError("channel closed"))
                    raise
                if sent and not sent.done():
                    sent.set_result(None)
        finally:
            ended.set()
            while not outbox.empty():
                _, sent, _ = outbox.get_nowait()
                if sent and not sent.done():
                    sent.set_exception(ConnectionError("channel closed"))

    async def reader() -> None:
        while True:
            event = await websocket.receive()
            if event["type"] == "websocket.disconnect":
                return
            if event.get("bytes") is not None:
                await _audio(link, event["bytes"])
            else:
                await _dispatch(link, event.get("text"))

    link = _Link(device_id, owner_id, reply, close, session_id=session_id, token_exp=int(claims["exp"]), voice_output=voice_output)
    tasks: list[asyncio.Task[Any]] = [asyncio.create_task(writer())]
    unregister: Callable[[], None] | None = None
    try:
        await reply({"type": "ready", "device_id": device_id})
        # Registration order and epoch allocation must agree, even when two
        # reconnects race while one awaits database I/O.
        async with hub.connection_lock(device_id):
            if (code := await _validate(owner_id, device_id, session_id)) is not None:
                await close(code)
                return
            # Fence the previous reader, then revalidate before exposing this
            # socket to hub pushes. Revocation uses the same connection lock.
            link.character_epoch = await _begin_character_session(link)
            if (code := await _validate(owner_id, device_id, session_id)) is not None:
                await close(code)
                return
            unregister = hub.register(device_id, owner_id, push, close)
        # After register and under the owner's lock: a concurrent push can't land after it. No snapshot, no session.
        if not await hub.push_snapshot(device_id):
            await close(ERROR_CLOSE_CODE)
            return
        tasks += [asyncio.create_task(reader()), asyncio.create_task(gone.wait()),
                  asyncio.create_task(_supervise(link, session_id, int(claims["exp"])))]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        failed: Any = next((t.exception() for t in done if not t.cancelled() and t.exception()), None)
        if failed:
            logger.warning("companion channel failed device=%s reason=%s", device_id, type(failed).__name__)
            await close(ERROR_CLOSE_CODE)
    finally:
        _cancel_voice(link)
        if unregister:
            unregister()
        for task in tasks:  # not awaited: under a cancelled host task (server shutdown, test client) gathering them leaks the cancellation
            task.cancel()
        await close(1000)
