"""Idempotent device actions: the board repeats an id after a lost reply, the effect happens once."""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from app.ai.errors import PolicyDenied
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.companion.models import CompanionAction
from app.core.models import Device
from app.domains import focus_service, task_service
from app.domains.api import set_notification_read
from fastapi import HTTPException
from pydantic import UUID4, BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)
# Service error codes the board may see; any other HTTP failure is reported as ACTION_FAILED.
BOARD_ERROR_CODES = frozenset({"TIMER_ACTIVE", "NOT_FOUND", "VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "INVALID_STATE"})

# Static grant to every companion; each action kind demands exactly one scope. The denial path is exercised by tests.
COMPANION_SCOPES = frozenset({"companion.notifications", "companion.focus", "companion.tasks"})


class ActionIn(BaseModel):
    id: UUID4
    kind: str = Field(max_length=40)
    payload: dict = {}


class ActionResult(BaseModel):
    id: UUID4
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
    notification_id = payload.get("notification_id")
    if not isinstance(notification_id, str):
        return "NOT_FOUND"
    try:
        await set_notification_read(notification_id, owner_id, db)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        return "NOT_FOUND"
    return None


async def _focus_start(db: AsyncSession, owner_id: str, payload: dict[str, Any]) -> str | None:
    mode = payload.get("mode", "pomodoro")
    if mode not in ("pomodoro", "stopwatch"):
        return "VALIDATION_ERROR"
    await focus_service.start_focus(db, owner_id, started_at=datetime.now(UTC), mode=mode, task_id=None, idempotency_key=None)
    return None


def _focus_change(paused: bool | None) -> Handler:
    """pause/resume when `paused` is a bool, stop when None; all act on the owner's one active session."""
    async def handler(db: AsyncSession, owner_id: str, payload: dict[str, Any]) -> str | None:
        item = await focus_service.active_focus(db, owner_id)
        if item is None:
            return "NO_ACTIVE_FOCUS"
        if paused is None:
            await focus_service.stop_focus(db, owner_id, item.id, None)
        else:
            await focus_service.set_focus_paused(db, owner_id, item.id, paused, None)
        return None
    return handler


async def _task_complete(db: AsyncSession, owner_id: str, payload: dict[str, Any]) -> str | None:
    task_id = payload.get("task_id")
    if not isinstance(task_id, str):
        return "NOT_FOUND"
    await task_service.complete_task(db, owner_id, task_id)
    return None


ACTION_HANDLERS: dict[str, Handler] = {
    "notification.read": _notification_read, "focus.start": _focus_start, "focus.pause": _focus_change(True),
    "focus.resume": _focus_change(False), "focus.stop": _focus_change(None), "task.complete": _task_complete}
ACTION_SCOPES: dict[str, str] = {
    "notification.read": "companion.notifications", "focus.start": "companion.focus", "focus.pause": "companion.focus",
    "focus.resume": "companion.focus", "focus.stop": "companion.focus", "task.complete": "companion.tasks"}


async def _stored(db: AsyncSession, device_id: str, action_id: UUID4) -> ActionResult | None:
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
            try:
                error = await handler(db, owner_id, action.payload)
            except HTTPException as exc:
                code = exc.detail.get("code") if isinstance(exc.detail, dict) else None
                if code not in BOARD_ERROR_CODES:
                    logger.warning("companion action %s failed with %s", action.kind, code or exc.status_code)
                    code = "ACTION_FAILED"
                error = code
    if error is not None:
        # A failed action must leave no half-done effect (a handler may have written before it raised).
        await db.rollback()
    result = ActionResult(id=action.id, ok=error is None, error_code=error)
    # The effect and its ledger row share one transaction, so a losing concurrent insert rolls both back.
    db.add(CompanionAction(id=str(action.id), owner_id=owner_id, device_id=device_id, kind=action.kind,
                           result_json=result.model_dump(mode="json", exclude={"id"})))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if (replay := await _stored(db, device_id, action.id)) is None:
            raise
        return replay
    return result
