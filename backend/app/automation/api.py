from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from app.ai.errors import PolicyDenied, ToolValidationError, redact_error
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.ai.tools import ToolDescriptor, ToolRegistry
from app.core.db import get_db
from app.core.models import (
    ActivityEvent,
    AutomationExecution,
    AutomationRule,
    Notification,
    Project,
    Task,
    now,
)
from app.core.security import current_principal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    TypeAdapter,
    ValidationError,
)
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()


class CreateTaskArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: StrictStr = Field(min_length=1, max_length=300)
    description: StrictStr = Field(default="", max_length=10_000)
    project_id: StrictStr | None = Field(default=None, max_length=36)


class CreateNotificationArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: StrictStr = Field(default="automation", min_length=1, max_length=80)
    title: StrictStr = Field(default="Automation", min_length=1, max_length=300)
    body: StrictStr = Field(default="", max_length=20_000)


class CreateTaskAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["create_task"]
    args: CreateTaskArgs


class CreateNotificationAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["create_notification"]
    args: CreateNotificationArgs


AutomationAction = Annotated[
    CreateTaskAction | CreateNotificationAction,
    Field(discriminator="kind"),
]
_ACTION_ADAPTER = TypeAdapter(AutomationAction)


class RuleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: StrictStr = Field(min_length=1, max_length=200)
    trigger_kind: StrictStr = Field(min_length=1, max_length=80)
    conditions: dict[str, Any] = Field(default_factory=dict)
    actions: list[AutomationAction] = Field(min_length=1, max_length=20)
    policy_ref: StrictStr = Field(min_length=1, max_length=100)
    rate_limit: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class RulePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: StrictStr | None = Field(default=None, min_length=1, max_length=200)
    enabled: bool | None = None
    trigger_kind: StrictStr | None = Field(default=None, min_length=1, max_length=80)
    conditions: dict[str, Any] | None = None
    actions: list[AutomationAction] | None = Field(
        default=None, min_length=1, max_length=20
    )
    policy_ref: StrictStr | None = Field(default=None, min_length=1, max_length=100)
    rate_limit: dict[str, Any] | None = None


class EventIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: StrictStr = Field(min_length=1, max_length=150)
    event_kind: StrictStr = Field(min_length=1, max_length=80)
    payload: dict[str, Any] = Field(default_factory=dict)


class RateLimitConfig(BaseModel):
    """The small durable dispatch limit supported by this route."""

    model_config = ConfigDict(extra="forbid")

    max_executions: StrictInt = Field(gt=0, le=100_000)
    window_seconds: StrictInt = Field(gt=0, le=31_536_000)


@dataclass(frozen=True)
class ExecutionClaim:
    execution: AutomationExecution
    status: Literal["running", "rate_limited"]


# A policy reference is data stored on a rule, not an authorization decision.
# Only references in this registry can be used for an execution.
_REGISTERED_POLICIES: dict[str, frozenset[str]] = {
    "safe": frozenset({"tasks.write", "notifications.write"}),
}


def _http_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code, detail={"code": code, "message": message}
    )


def _serialize_actions(actions: list[AutomationAction]) -> list[dict[str, Any]]:
    return [action.model_dump(mode="json") for action in actions]


def _normalize_rate_limit(raw_rate_limit: Any) -> dict[str, int]:
    if raw_rate_limit in (None, {}):
        return {}
    if not isinstance(raw_rate_limit, dict):
        raise _http_error(
            422,
            "VALIDATION_ERROR",
            "rate_limit must contain max_executions and window_seconds",
        )
    try:
        return RateLimitConfig.model_validate(raw_rate_limit).model_dump(mode="json")
    except ValidationError:
        raise _http_error(
            422,
            "VALIDATION_ERROR",
            "rate_limit must contain positive max_executions and window_seconds",
        ) from None


def _parse_actions(
    raw_actions: Any, payload: Mapping[str, Any]
) -> list[AutomationAction]:
    if not isinstance(raw_actions, list) or not raw_actions:
        raise ToolValidationError("automation actions must be a non-empty list")

    parsed: list[AutomationAction] = []
    for raw_action in raw_actions:
        try:
            action = _ACTION_ADAPTER.validate_python(raw_action)
            args = action.args.model_dump(mode="json", exclude_none=True)
            # The event may provide the scoped project for a task action. It is
            # still validated as a strict action argument below.
            if (
                isinstance(action, CreateTaskAction)
                and "project_id" not in args
                and "project_id" in payload
            ):
                args["project_id"] = payload["project_id"]
                action = _ACTION_ADAPTER.validate_python(
                    {"kind": action.kind, "args": args}
                )
            parsed.append(action)
        except ValidationError as exc:
            raise ToolValidationError("invalid automation action") from exc
    return parsed


async def _owned_project(
    db: AsyncSession, owner_id: str, project_id: str
) -> Project | None:
    return (
        await db.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == owner_id,
                Project.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _require_action_scope(
    db: AsyncSession, owner_id: str, action: AutomationAction
) -> str | None:
    if not isinstance(action, CreateTaskAction) or action.args.project_id is None:
        return None
    if await _owned_project(db, owner_id, action.args.project_id) is None:
        raise _http_error(404, "NOT_FOUND", "Automation project not found")
    return action.args.project_id


def _policy_context(
    policy_ref: str, actor: str, project_id: str | None
) -> PermissionContext:
    scopes = _REGISTERED_POLICIES.get(policy_ref)
    if scopes is None:
        raise PolicyDenied("automation policy is not registered")
    return PermissionContext(
        actor=actor,
        scopes=scopes,
        project_ids=frozenset({project_id}) if project_id else frozenset(),
        allow_external_effects=False,
        policy_id=policy_ref,
    )


def _typed_validator(model_type: type[BaseModel]):
    def validate(arguments: Mapping[str, Any]) -> Mapping[str, Any]:
        return model_type.model_validate(arguments).model_dump(
            mode="json", exclude_none=True
        )

    return validate


def _build_action_registry(
    db: AsyncSession, owner_id: str, event_id: str
) -> ToolRegistry:
    registry = ToolRegistry(ServerPolicyEngine())

    async def create_task(arguments: Mapping[str, Any]) -> Mapping[str, Any]:
        project_id = arguments.get("project_id")
        if (
            project_id is not None
            and await _owned_project(db, owner_id, str(project_id)) is None
        ):
            raise ValueError("automation project is outside the owner scope")
        item = Task(
            owner_id=owner_id,
            title=str(arguments["title"]),
            description=str(arguments.get("description", "")),
            project_id=str(project_id) if project_id is not None else None,
        )
        db.add(item)
        await db.flush()
        db.add(ActivityEvent(owner_id=owner_id, resource_id=item.id, event_kind="automation.task.created", actor_kind="automation", actor_id=None, non_sensitive_metadata={"event_id": event_id}))
        return {"action": "create_task", "task_id": item.id, "event_id": event_id}

    async def create_notification(arguments: Mapping[str, Any]) -> Mapping[str, Any]:
        item = Notification(
            owner_id=owner_id,
            kind=str(arguments.get("kind", "automation")),
            title=str(arguments.get("title", "Automation")),
            body=str(arguments.get("body", "")),
            data_json={"event_id": event_id},
        )
        db.add(item)
        await db.flush()
        db.add(ActivityEvent(owner_id=owner_id, resource_id=item.id, event_kind="automation.notification.created", actor_kind="automation", actor_id=None, non_sensitive_metadata={"event_id": event_id}))
        return {
            "action": "create_notification",
            "notification_id": item.id,
            "event_id": event_id,
        }

    # This is the mounted route's complete action allowlist. Every descriptor
    # has a real handler and a strict validator; unknown actions cannot reach
    # the policy engine or the domain tables.
    registry.register(
        ToolDescriptor(
            name="create_task",
            description="Create an owner-scoped task",
            required_scope="tasks.write",
            validator=_typed_validator(CreateTaskArgs),
            handler=create_task,
        )
    )
    registry.register(
        ToolDescriptor(
            name="create_notification",
            description="Create an owner-scoped notification",
            required_scope="notifications.write",
            validator=_typed_validator(CreateNotificationArgs),
            handler=create_notification,
        )
    )
    return registry


async def _authorize_action(
    *,
    registry: ToolRegistry,
    action: AutomationAction,
    policy_ref: str,
    actor: str,
    project_id: str | None,
) -> Mapping[str, Any]:
    args = action.args.model_dump(mode="json", exclude_none=True)
    call = ToolCall(action.kind, args)
    context = _policy_context(policy_ref, actor, project_id)
    registry.authorize(call, context)
    return registry.validate(call)


async def _claim_execution(
    db: AsyncSession,
    *,
    owner_id: str,
    rule_id: str,
    event_id: str,
    rate_limit: Mapping[str, int],
) -> ExecutionClaim | None:
    """Claim an event, retrying only durable failed receipts.

    The rule row is locked while the existing execution receipts are counted,
    so the rate-limit decision is made against a stable owner/rule window.
    SQLite uses its immediate writer transaction; PostgreSQL uses the row
    lock. A rate-limited event is itself stored as a durable receipt.
    """

    if db.get_bind().dialect.name == "sqlite":
        await db.execute(text("BEGIN IMMEDIATE"))
    await db.execute(
        select(AutomationRule.id)
        .where(
            AutomationRule.id == rule_id,
            AutomationRule.owner_id == owner_id,
        )
        .with_for_update()
    )
    prior = (
        await db.execute(
            select(AutomationExecution)
            .where(
                AutomationExecution.owner_id == owner_id,
                AutomationExecution.rule_id == rule_id,
                AutomationExecution.event_id == event_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if prior is not None and prior.run_status != "failed":
        return None

    started_at = now()
    consumed = 0
    if rate_limit:
        cutoff = started_at - timedelta(seconds=rate_limit["window_seconds"])
        consumed = int(
            await db.scalar(
                select(func.count())
                .select_from(AutomationExecution)
                .where(
                    AutomationExecution.owner_id == owner_id,
                    AutomationExecution.rule_id == rule_id,
                    AutomationExecution.started_at >= cutoff,
                    AutomationExecution.run_status.in_(
                        ("running", "completed", "failed", "rate_limited")
                    ),
                )
            )
            or 0
        )

        # A failed receipt remains intact when its retry is currently over the
        # limit. The caller receives a rate_limited decision and can retry the
        # same event after the window expires.
        if prior is not None and consumed >= rate_limit["max_executions"]:
            return ExecutionClaim(prior, "rate_limited")

    if prior is None:
        execution = AutomationExecution(
            owner_id=owner_id,
            rule_id=rule_id,
            event_id=event_id,
            run_status=(
                "rate_limited"
                if rate_limit and consumed >= rate_limit["max_executions"]
                else "running"
            ),
            started_at=started_at,
            finished_at=(now() if rate_limit and consumed >= rate_limit["max_executions"] else None),
            error_code=(
                "RATE_LIMITED"
                if rate_limit and consumed >= rate_limit["max_executions"]
                else None
            ),
        )
        db.add(execution)
    else:
        execution = prior
        execution.attempt += 1
        execution.run_status = "running"
        execution.started_at = started_at
        execution.finished_at = None
        execution.error_code = None

    try:
        async with db.begin_nested():
            await db.flush()
    except IntegrityError:
        prior = (
            await db.execute(
                select(AutomationExecution).where(
                    AutomationExecution.owner_id == owner_id,
                    AutomationExecution.rule_id == rule_id,
                    AutomationExecution.event_id == event_id,
                )
            )
        ).scalar_one_or_none()
        if prior is not None:
            return None
        raise _http_error(
            409, "DISPATCH_RETRY", "Automation dispatch claim could not be verified"
        )
    return ExecutionClaim(
        execution,
        "rate_limited" if execution.run_status == "rate_limited" else "running",
    )


@router.get("/automations")
async def list_rules(
    principal=Depends(current_principal), db: AsyncSession = Depends(get_db)
):
    user, _ = principal
    return list(
        (
            await db.execute(
                select(AutomationRule).where(
                    AutomationRule.owner_id == user.id,
                    AutomationRule.deleted_at.is_(None),
                )
            )
        ).scalars()
    )


@router.post("/automations")
async def create_rule(
    body: RuleIn,
    principal=Depends(current_principal),
    db: AsyncSession = Depends(get_db),
):
    user, _ = principal
    item = AutomationRule(
        owner_id=user.id,
        name=body.name,
        trigger_kind=body.trigger_kind,
        conditions_json=body.conditions,
        actions_json=_serialize_actions(body.actions),
        policy_ref=body.policy_ref,
        rate_limit_json=_normalize_rate_limit(body.rate_limit),
        enabled=body.enabled,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item


@router.patch("/automations/{rule_id}")
async def update_rule(
    rule_id: str,
    body: RulePatch,
    principal=Depends(current_principal),
    db: AsyncSession = Depends(get_db),
):
    user, _ = principal
    item = await db.get(AutomationRule, rule_id)
    if not item or item.owner_id != user.id:
        raise _http_error(404, "NOT_FOUND", "Rule not found")
    if body.name is not None:
        item.name = body.name
    if body.enabled is not None:
        item.enabled = body.enabled
    if body.trigger_kind is not None:
        item.trigger_kind = body.trigger_kind
    if body.conditions is not None:
        item.conditions_json = body.conditions
    if body.actions is not None:
        item.actions_json = _serialize_actions(body.actions)
    if body.policy_ref is not None:
        item.policy_ref = body.policy_ref
    if body.rate_limit is not None:
        item.rate_limit_json = _normalize_rate_limit(body.rate_limit)
    await db.commit()
    await db.refresh(item)
    return item


@router.delete("/automations/{rule_id}")
async def delete_rule(
    rule_id: str,
    principal=Depends(current_principal),
    db: AsyncSession = Depends(get_db),
):
    user, _ = principal
    item = await db.get(AutomationRule, rule_id)
    if not item or item.owner_id != user.id:
        raise _http_error(404, "NOT_FOUND", "Rule not found")
    item.deleted_at = datetime.now(UTC)
    item.enabled = False
    await db.commit()
    return {"deleted": True}


@router.get("/automations/{rule_id}/executions")
async def executions(
    rule_id: str,
    principal=Depends(current_principal),
    db: AsyncSession = Depends(get_db),
):
    user, _ = principal
    item = await db.get(AutomationRule, rule_id)
    if not item or item.owner_id != user.id:
        raise _http_error(404, "NOT_FOUND", "Rule not found")
    return list(
        (
            await db.execute(
                select(AutomationExecution)
                .where(
                    AutomationExecution.owner_id == user.id,
                    AutomationExecution.rule_id == rule_id,
                )
                .order_by(AutomationExecution.started_at.desc())
            )
        ).scalars()
    )


@router.post("/automations/{rule_id}/dry-run")
async def dry_run(
    rule_id: str,
    body: EventIn,
    principal=Depends(current_principal),
    db: AsyncSession = Depends(get_db),
):
    user, _ = principal
    item = await db.get(AutomationRule, rule_id)
    if not item or item.owner_id != user.id:
        raise _http_error(404, "NOT_FOUND", "Rule not found")
    matches = bool(
        item.enabled
        and item.trigger_kind == body.event_kind
        and isinstance(item.conditions_json, dict)
        and all(
            body.payload.get(key) == value
            for key, value in item.conditions_json.items()
        )
    )
    if not matches:
        return {
            "rule_id": rule_id,
            "event_id": body.event_id,
            "would_execute": False,
            "actions": [],
        }

    registry = _build_action_registry(db, user.id, body.event_id)
    try:
        actions = _parse_actions(item.actions_json, body.payload)
        for action in actions:
            project_id = await _require_action_scope(db, user.id, action)
            await _authorize_action(
                registry=registry,
                action=action,
                policy_ref=item.policy_ref,
                actor=f"automation:{item.id}",
                project_id=project_id,
            )
    except PolicyDenied:
        raise _http_error(
            403, "POLICY_DENIED", "Automation action is not authorized"
        ) from None
    except ToolValidationError:
        raise _http_error(
            422, "VALIDATION_ERROR", "Automation action arguments are invalid"
        ) from None
    return {
        "rule_id": rule_id,
        "event_id": body.event_id,
        "would_execute": True,
        "actions": _serialize_actions(actions),
    }


@router.post("/automations/dispatch")
async def dispatch(
    body: EventIn,
    principal=Depends(current_principal),
    db: AsyncSession = Depends(get_db),
):
    user, _ = principal
    rules = list(
        (
            await db.execute(
                select(AutomationRule).where(
                    AutomationRule.owner_id == user.id,
                    AutomationRule.enabled.is_(True),
                    AutomationRule.deleted_at.is_(None),
                    AutomationRule.trigger_kind == body.event_kind,
                )
            )
        ).scalars()
    )
    results: list[dict[str, str]] = []

    for rule in rules:
        if not isinstance(rule.conditions_json, dict) or not all(
            body.payload.get(key) == value
            for key, value in rule.conditions_json.items()
        ):
            continue

        execution: AutomationExecution | None = None
        try:
            actions = _parse_actions(rule.actions_json, body.payload)
            claim = await _claim_execution(
                db,
                owner_id=user.id,
                rule_id=rule.id,
                event_id=body.event_id,
                rate_limit=_normalize_rate_limit(rule.rate_limit_json),
            )
            if claim is None:
                results.append({"rule_id": rule.id, "status": "duplicate"})
                continue
            execution = claim.execution
            if claim.status == "rate_limited":
                results.append({"rule_id": rule.id, "status": "rate_limited"})
                continue

            registry = _build_action_registry(db, user.id, body.event_id)
            # Domain action writes share a savepoint. A failure keeps the
            # execution receipt in the outer transaction while rolling back
            # every partial action from this event.
            async with db.begin_nested():
                for action in actions:
                    project_id = await _require_action_scope(db, user.id, action)
                    await _authorize_action(
                        registry=registry,
                        action=action,
                        policy_ref=rule.policy_ref,
                        actor=f"automation:{rule.id}",
                        project_id=project_id,
                    )
                    await registry.invoke(
                        ToolCall(
                            action.kind,
                            action.args.model_dump(mode="json", exclude_none=True),
                        ),
                        _policy_context(
                            rule.policy_ref, f"automation:{rule.id}", project_id
                        ),
                    )
            execution.run_status = "completed"
            execution.finished_at = now()
            results.append({"rule_id": rule.id, "status": "completed"})
        except PolicyDenied:
            if execution is None:
                await db.rollback()
                raise _http_error(
                    403, "POLICY_DENIED", "Automation action is not authorized"
                ) from None
            execution.run_status = "failed"
            execution.error_code = "POLICY_DENIED"
            execution.finished_at = now()
            await db.commit()
            raise _http_error(
                403, "POLICY_DENIED", "Automation action is not authorized"
            ) from None
        except ToolValidationError:
            if execution is None:
                await db.rollback()
                raise _http_error(
                    422, "VALIDATION_ERROR", "Automation action arguments are invalid"
                ) from None
            execution.run_status = "failed"
            execution.error_code = "VALIDATION_ERROR"
            execution.finished_at = now()
            await db.commit()
            raise _http_error(
                422, "VALIDATION_ERROR", "Automation action arguments are invalid"
            ) from None
        except HTTPException as exc:
            if execution is None:
                await db.rollback()
                raise
            execution.run_status = "failed"
            detail: dict[str, Any] = exc.detail if isinstance(exc.detail, dict) else {}
            execution.error_code = str(detail.get("code", "ACTION_FAILED"))[:80]
            execution.finished_at = now()
            await db.commit()
            raise
        except RuntimeError as exc:
            # ToolRegistry redacts handler failures. Do not commit a partial
            # action set or expose implementation details to the caller.
            message = redact_error(exc)
            if execution is None:
                await db.rollback()
                raise _http_error(422, "ACTION_FAILED", message) from None
            execution.run_status = "failed"
            execution.error_code = "ACTION_FAILED"
            execution.finished_at = now()
            await db.commit()
            raise _http_error(422, "ACTION_FAILED", message) from None
        except Exception:
            # Keep unexpected handler failures auditable without returning
            # implementation details. The nested savepoint has already
            # removed any partial domain writes.
            if execution is None:
                await db.rollback()
                raise _http_error(
                    422, "ACTION_FAILED", "Automation action failed"
                ) from None
            execution.run_status = "failed"
            execution.error_code = "ACTION_FAILED"
            execution.finished_at = now()
            await db.commit()
            raise _http_error(422, "ACTION_FAILED", "Automation action failed") from None

    await db.commit()
    return {"event_id": body.event_id, "results": results}
