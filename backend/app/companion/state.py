"""Row-locked access to CompanionState; the API and the channel both change the pending-command queue through here."""
from __future__ import annotations

import uuid
from typing import Any

from app.companion.models import CompanionState
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

COMMAND_NAMES = frozenset({"lost_mode", "play_sound", "ice_update", "wifi_add", "wifi_scan"})


def valid_command(entry: Any) -> bool:
    """Exactly {"id": uuid4 str, "name": a known command, "args": dict}."""
    if not isinstance(entry, dict) or set(entry) != {"id", "name", "args"}:
        return False
    if entry["name"] not in COMMAND_NAMES or not isinstance(entry["args"], dict) or not isinstance(entry["id"], str):
        return False
    try:
        parsed = uuid.UUID(entry["id"])
    except ValueError:
        return False
    return parsed.version == 4 and str(parsed) == entry["id"]


async def locked_state(db: AsyncSession, device_id: str, owner_id: str) -> CompanionState:
    """The device's state row, created if missing, locked until the caller commits.

    Every read-modify-write of the row (pending commands above all) must start here: the insert makes creation
    race-free, the row lock serialises writers so none overwrites another's change.
    """
    dialect = db.get_bind().dialect.name
    if dialect not in ("postgresql", "sqlite"):
        raise ValueError("Companion state requires PostgreSQL or SQLite")
    insert = pg_insert if dialect == "postgresql" else sqlite_insert
    await db.execute(insert(CompanionState).values(device_id=device_id, owner_id=owner_id, pending_commands_json=[])
                     .on_conflict_do_nothing(index_elements=["device_id"]))
    row = await db.get(CompanionState, device_id, with_for_update=True, populate_existing=True)
    if row is None:  # pragma: no cover - the insert above guarantees it
        raise RuntimeError("companion state row missing")
    return row


def queue_command(row: CompanionState, name: str, args: dict) -> dict:
    """Add a command to the row's queue, replacing any pending one of the same name; returns the new entry."""
    entry = {"id": str(uuid.uuid4()), "name": name, "args": args}
    if not valid_command(entry):
        raise ValueError("invalid companion command")
    # A new list: JSON columns don't track in-place edits. Malformed leftovers are dropped on the way.
    row.pending_commands_json = [c for c in row.pending_commands_json or [] if valid_command(c) and c["name"] != name] + [entry]
    return entry


async def lost_mode_on(db: AsyncSession, device_id: str) -> bool:
    """Whether the owner has put this board in lost mode; the server then hides data from it and refuses its actions."""
    lost = (await db.execute(select(CompanionState.lost_mode_json).where(CompanionState.device_id == device_id))).scalar_one_or_none()
    return bool(lost and lost.get("on"))
