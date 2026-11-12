"""Idempotent device actions: the board repeats an id after a lost reply, the effect happens once."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from app.ai.errors import PolicyDenied
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.companion.models import CompanionAction
from app.core.models import Device
from app.domains.api import set_notification_read
from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

# Every scope a paired board may hold; each action kind demands exactly one of them.
COMPANION_SCOPES = frozenset({"companion.notifications", "companion.focus", "companion.tasks"})


class ActionIn(BaseModel):
    id: UUID
    kind: str
    payload: dict = {}


class ActionResult(BaseModel):
    id: UUID
    ok: bool
    error_code: str | None = None


# A handler applies its effect without committing and returns an error code, or None on success.
Handler = Callable[[AsyncSession, str, dict[str, Any]], Awaitable[str | None]]


@dataclass(frozen=True)
class _Tool:
    name: str
    required_scope: str
    external_effect: bool = False


async def _notification_read(db: AsyncSession, owner_id: str, payload: dict[str, Any]) -> str | None:
    try:
        await set_notification_read(str(payload.get("notification_id")), owner_id, db)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        return "NOT_FOUND"
    return None


ACTION_HANDLERS: dict[str, Handler] = {"notification.read": _notification_read}
ACTION_SCOPES: dict[str, str] = {"notification.read": "companion.notifications"}


async def _stored(db: AsyncSession, device_id: str, action_id: UUID) -> ActionResult | None:
    row = (await db.execute(select(CompanionAction).where(
        CompanionAction.device_id == device_id, CompanionAction.id == str(action_id)))).scalar_one_or_none()
    return ActionResult(id=action_id, **row.result_json) if row else None


async def run_action(db: AsyncSession, owner_id: str, device: Device, action: ActionIn) -> ActionResult:
    device_id = device.id  # read now: a rollback expires the ORM device and an async refresh would fail
    if (replay := await _stored(db, device_id, action.id)) is not None:
        return replay
    handler = ACTION_HANDLERS.get(action.kind)
    if handler is None:
        error: str | None = "ACTION_UNKNOWN"
    else:
        scope = ACTION_SCOPES[action.kind]
        try:
            ServerPolicyEngine().authorize(_Tool(action.kind, scope), ToolCall(name=action.kind, arguments=action.payload), PermissionContext(
                actor=f"device:{device_id}", scopes=COMPANION_SCOPES, policy_id="companion-device"))
        except PolicyDenied:
            error = "POLICY_DENIED"
        else:
            error = await handler(db, owner_id, action.payload)
    result = ActionResult(id=action.id, ok=error is None, error_code=error)
    # The effect and its ledger row share one transaction, so a losing concurrent insert rolls both back.
    db.add(CompanionAction(id=str(action.id), owner_id=owner_id, device_id=device_id, kind=action.kind[:40],
                           result_json=result.model_dump(mode="json", exclude={"id"})))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if (replay := await _stored(db, device_id, action.id)) is None:
            raise
        return replay
    return result
