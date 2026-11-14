"""The owner's commands to a desk board and its state. Owner devices only; the board's allow-list never lists these."""
from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from app.companion.character import CharacterStatusOut
from app.companion.hub import hub
from app.companion.models import CompanionState
from app.companion.state import locked_state, log_command, queue_command
from app.core.db import get_db
from app.core.device_auth import _aware, trusted_device, verify_signature
from app.core.models import Device, DeviceChallenge, User, now
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()

LOST_OFF_CONTEXT = "aelys-companion-lost-off-v1"
UNPAIR_CONTEXT = "aelys-companion-unpair-v1"
WIFI_BLOB_MAX_BYTES = 512


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


class Reauth(BaseModel):
    challenge_id: str = Field(max_length=64)
    signature: str = Field(max_length=200)


class LostModeIn(BaseModel):
    on: bool
    message: str = Field(default="", max_length=64)
    show_phone: bool = False
    show_telegram: bool = False
    show_email: bool = False  # v1.1
    email: str | None = Field(default=None, max_length=48)
    qr: Literal["telegram", "phone", "none"] = "telegram"
    reauth: Reauth | None = None


class Contact(BaseModel):
    name: str = Field(max_length=32)
    relation: str = Field(default="", max_length=16)  # v1.1
    phone: str = Field(max_length=23)


class IceIn(BaseModel):
    owner_name: str = Field(default="", max_length=32)  # v1.1
    contacts: list[Contact] = Field(max_length=2)
    med_note: str = Field(default="", max_length=96)
    show_name: bool = False
    show_contacts: bool = True  # v1.1
    show_med: bool = True


class CompanionSettingsIn(BaseModel):
    brightness: int = Field(ge=5, le=100)


class WifiRemoveIn(BaseModel):
    ssid: str = Field(min_length=1, max_length=32)


class WifiOrderIn(BaseModel):
    ssids: list[Annotated[str, Field(min_length=1, max_length=32)]] = Field(max_length=5)


class UnpairIn(BaseModel):
    reauth: Reauth | None = None


class WifiIn(BaseModel):
    blob: str = Field(min_length=1, max_length=700, pattern=r"^[A-Za-z0-9_-]+={0,2}$")

    @field_validator("blob")
    @classmethod
    def _decodes_small(cls, value: str) -> str:
        try:
            size = len(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        except ValueError as error:
            raise ValueError("blob must be base64url") from error
        if size > WIFI_BLOB_MAX_BYTES:
            raise ValueError("blob is larger than 512 bytes")
        return value


class CommandOut(BaseModel):
    id: str
    delivered: bool  # false: queued, the board gets it after its next hello


class DeviceStateOut(BaseModel):
    device_id: str
    display_name: str
    online: bool
    last_seen_at: datetime | None
    fw_version: str | None
    public_key: str | None
    lost_mode: dict | None
    ice: dict | None
    last_metrics: dict | None
    character: CharacterStatusOut | None = None
    last_wifi_scan: dict | None
    # v1.1
    contacts: dict | None = None
    wifi: dict | None = None
    battery: dict | None = None
    settings: dict | None = None
    command_log: list[dict] = []


class DeviceListItem(BaseModel):
    device_id: str
    display_name: str
    online: bool
    last_seen_at: datetime | None
    wifi_current: str | None
    battery_pct: int | None


async def owner_caller(principal: tuple[User, Device] = Depends(trusted_device)) -> tuple[User, Device]:
    if principal[1].platform == "companion":
        raise _error(403, "DEVICE_SCOPE_DENIED", "This device may not use this endpoint")
    return principal


async def target_board(device_id: str, principal: tuple[User, Device] = Depends(owner_caller), db: AsyncSession = Depends(get_db)) -> tuple[User, Device, Device]:
    user, caller = principal
    board = await db.get(Device, device_id)
    if board is None or board.owner_id != user.id or board.platform != "companion" or board.revoked_at:
        raise _error(404, "NOT_FOUND", "Companion not found")
    return user, caller, board


async def _send_now(db: AsyncSession, user: User, board: Device, name: str, args: dict[str, Any]) -> CommandOut:
    """For commands that make no sense later: never queued, so an offline board is a conflict."""
    command_id = str(uuid.uuid4())
    if not hub.is_online(board.id):
        raise _error(409, "DEVICE_OFFLINE", "The companion is offline")
    row = await locked_state(db, board.id, user.id)
    log_command(row, command_id, name)  # before the send: the ack may come back at once, or only after a reconnect
    await db.commit()
    if not await hub.send_to_device(board.id, {"type": "command", "id": command_id, "name": name, "args": args}):
        raise _error(409, "DEVICE_OFFLINE", "The companion is offline")
    return CommandOut(id=command_id, delivered=True)


async def _send_or_queue(db: AsyncSession, user: User, board: Device, name: str, args: dict[str, Any], field: str) -> CommandOut:
    """Store the new value and keep the command pending until the board acks it; if it is online it also goes out now."""
    row = await locked_state(db, board.id, user.id)
    # rev lets the board drop a stale copy that arrives after a newer one; read under the row lock so revs never repeat.
    args = {**args, "rev": int((getattr(row, field) or {}).get("rev", 0)) + 1}
    if name == "lost_mode":  # since is server-set: kept while lost mode stays on, new when it goes on, gone when it goes off
        previous = getattr(row, field) or {}
        if args["on"]:
            row.character_json = None  # a lost board does not expose a stale private reason
            args["since"] = previous["since"] if previous.get("on") and previous.get("since") else datetime.now(UTC).isoformat()
    setattr(row, field, args)
    command = queue_command(row, name, args)
    log_command(row, command["id"], name)
    await db.commit()
    delivered = await hub.send_to_device(board.id, {"type": "command", **command})
    if name == "lost_mode":  # the snapshot gate changed: an online board gets the redacted (or restored) view now
        await hub.push_snapshot(board.id)
    return CommandOut(id=command["id"], delivered=delivered)


async def _check_reauth(db: AsyncSession, caller: Device, board: Device, reauth: Reauth | None,
                        context: str = LOST_OFF_CONTEXT, action: str = "turn lost mode off") -> None:
    """A fresh signature by the calling device over this board's purpose-bound message; the challenge is burned first."""
    denied = _error(403, "REAUTH_REQUIRED", f"Confirm with this device's key to {action}")
    if reauth is None or not caller.public_key:
        raise denied
    challenge = await db.get(DeviceChallenge, reauth.challenge_id)
    if challenge is None or challenge.device_id != caller.id or challenge.used_at:
        raise denied
    if _aware(challenge.expires_at) <= now():
        raise denied
    burned = await db.execute(update(DeviceChallenge).where(DeviceChallenge.id == challenge.id, DeviceChallenge.used_at.is_(None)).values(used_at=now()))
    await db.commit()
    if int(getattr(burned, "rowcount", 0) or 0) != 1:
        raise denied
    if not verify_signature(caller.public_key, f"{context}\n{board.id}\n{challenge.nonce}".encode(), reauth.signature):
        raise denied


def _battery(metrics: dict | None) -> dict | None:
    if not metrics or metrics.get("battery_pct") is None:
        return None
    return {"pct": metrics["battery_pct"], "charging": bool(metrics.get("charging", False))}


@router.get("/devices", response_model=list[DeviceListItem])
async def list_devices(principal: tuple[User, Device] = Depends(owner_caller), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    boards = (await db.execute(select(Device).where(Device.owner_id == user.id, Device.platform == "companion", Device.revoked_at.is_(None))
                               .order_by(Device.created_at, Device.id))).scalars().all()
    states = {s.device_id: s for s in (await db.execute(select(CompanionState).where(CompanionState.owner_id == user.id))).scalars()}
    return [DeviceListItem(device_id=b.id, display_name=b.display_name, online=hub.is_online(b.id), last_seen_at=b.last_seen_at,
                           wifi_current=((st := states.get(b.id)) and st.wifi_json or {}).get("current"),
                           battery_pct=(_battery(st and st.last_metrics_json) or {}).get("pct")) for b in boards]


@router.get("/devices/{device_id}", response_model=DeviceStateOut)
async def get_device(target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    _, _, board = target
    state = (await db.execute(select(CompanionState).where(CompanionState.device_id == board.id))).scalar_one_or_none()
    return DeviceStateOut(
        device_id=board.id, display_name=board.display_name, online=hub.is_online(board.id), last_seen_at=board.last_seen_at,
        fw_version=state and state.fw_version, public_key=board.public_key, lost_mode=state and state.lost_mode_json,
        ice=state and state.ice_json, last_metrics=state and state.last_metrics_json,
        character=state and state.character_seq >= 0 and not (state.lost_mode_json or {}).get("on") and state.character_json or None,
        last_wifi_scan=state and state.last_wifi_scan_json,
        contacts=state and state.contacts_json, wifi=state and state.wifi_json, battery=_battery(state and state.last_metrics_json),
        settings=state and state.settings_json and {"brightness": state.settings_json["brightness"]}, command_log=(state and state.command_log_json) or [])


@router.put("/devices/{device_id}/lost-mode", response_model=CommandOut)
async def put_lost_mode(body: LostModeIn, target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    user, caller, board = target
    if not body.on:
        await _check_reauth(db, caller, board, body.reauth)
    return await _send_or_queue(db, user, board, "lost_mode", body.model_dump(exclude={"reauth"}), "lost_mode_json")


@router.put("/devices/{device_id}/ice", response_model=CommandOut)
async def put_ice(body: IceIn, target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    user, _, board = target
    return await _send_or_queue(db, user, board, "ice_update", body.model_dump(), "ice_json")


@router.post("/devices/{device_id}/find", response_model=CommandOut)
async def find_device(target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    return await _send_now(db, target[0], target[2], "play_sound", {})


@router.post("/devices/{device_id}/wifi", response_model=CommandOut)
async def add_wifi(body: WifiIn, target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    return await _send_now(db, target[0], target[2], "wifi_add", {"blob": body.blob})  # opaque: forwarded, never stored or logged


@router.post("/devices/{device_id}/wifi-scan", response_model=CommandOut)
async def scan_wifi(target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    return await _send_now(db, target[0], target[2], "wifi_scan", {})


@router.put("/devices/{device_id}/settings", response_model=CommandOut)
async def put_settings(body: CompanionSettingsIn, target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    user, _, board = target
    return await _send_or_queue(db, user, board, "settings", body.model_dump(), "settings_json")


@router.post("/devices/{device_id}/wifi/remove", response_model=CommandOut)
async def remove_wifi(body: WifiRemoveIn, target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    return await _send_now(db, target[0], target[2], "wifi_remove", {"ssid": body.ssid})


@router.put("/devices/{device_id}/wifi/order", response_model=CommandOut)
async def order_wifi(body: WifiOrderIn, target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    return await _send_now(db, target[0], target[2], "wifi_order", {"ssids": body.ssids})


@router.post("/devices/{device_id}/restart", response_model=CommandOut)
async def restart_device(target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    return await _send_now(db, target[0], target[2], "restart", {})


@router.post("/devices/{device_id}/unpair", response_model=CommandOut)
async def unpair_device(body: UnpairIn, target=Depends(target_board), db: AsyncSession = Depends(get_db)):
    """Tell an online board to wipe its pairing, then revoke it either way; an offline board just loses its access."""
    user, caller, board = target
    board_id = board.id  # read now: the reauth commit expires the ORM objects
    await _check_reauth(db, caller, board, body.reauth, UNPAIR_CONTEXT, "unpair this companion")
    command_id = str(uuid.uuid4())
    delivered = await hub.send_to_device(board_id, {"type": "command", "id": command_id, "name": "unpair", "args": {}})
    from app.core.api import revoke  # lazy: core.api imports the companion hub

    await revoke(board_id, (user, caller), db)  # the same code path as POST /devices/{id}/revoke: closes the socket with 4403
    return CommandOut(id=command_id, delivered=delivered)
