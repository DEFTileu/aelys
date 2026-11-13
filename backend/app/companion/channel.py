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
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

from app.companion.actions import ActionIn, run_action
from app.companion.hub import hub
from app.companion.state import locked_state, record_ack, valid_command
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
class _Link:
    device_id: str
    owner_id: str
    reply: Callable[[dict], Awaitable[None]]
    close: Callable[[int], Awaitable[None]]


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


HANDLERS: dict[str, Callable[[_Link, dict], Awaitable[None]]] = {
    "hello": _hello, "heartbeat": _heartbeat, "metrics": _metrics, "action": _action,
    "command_ack": _command_ack, "wifi_scan_result": _wifi_scan_result, "wifi_state": _wifi_state}


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
    except ValidationError:
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
    outbox: asyncio.Queue[tuple[dict, asyncio.Future[None] | None]] = asyncio.Queue(OUTBOX_SIZE)
    ended = asyncio.Event()  # the writer is gone: nothing queued from now on would ever be sent
    gone = asyncio.Event()  # somebody closed the socket

    async def reply(message: dict) -> None:
        if ended.is_set():
            raise ConnectionError("channel closed")
        await outbox.put((message, None))

    async def push(message: dict) -> None:
        """The hub's send: resolves only once the frame has really gone out, so a dead socket is noticed."""
        if ended.is_set():
            raise ConnectionError("channel closed")
        sent: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        await outbox.put((message, sent))
        await sent

    async def close(code: int) -> None:
        if gone.is_set():
            return
        gone.set()
        with suppress(Exception):  # the peer may already be gone
            await websocket.close(code=code)

    async def writer() -> None:
        try:
            while True:
                message, sent = await outbox.get()
                try:
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
                _, sent = outbox.get_nowait()
                if sent and not sent.done():
                    sent.set_exception(ConnectionError("channel closed"))

    async def reader() -> None:
        while True:
            event = await websocket.receive()
            if event["type"] == "websocket.disconnect":
                return
            await _dispatch(link, event.get("text"))

    link = _Link(device_id, owner_id, reply, close)
    tasks: list[asyncio.Task[Any]] = [asyncio.create_task(writer())]
    unregister: Callable[[], None] | None = None
    try:
        await reply({"type": "ready", "device_id": device_id})
        unregister = hub.register(device_id, owner_id, push, close)
        if (code := await _validate(owner_id, device_id, session_id)) is not None:  # a revoke between the first check and register
            await close(code)
            return
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
        if unregister:
            unregister()
        for task in tasks:  # not awaited: under a cancelled host task (server shutdown, test client) gathering them leaks the cancellation
            task.cancel()
        await close(1000)
