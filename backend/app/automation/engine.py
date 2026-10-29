"""Bounded rule engine.  Every real action goes through the AI tool policy gate."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Any, Awaitable, Callable, Mapping
from uuid import UUID, uuid4

from ..ai.errors import PolicyDenied, redact_error
from ..ai.models import PermissionContext, ToolCall
from ..ai.policy import PolicyEngine
from ..ai.tools import ToolRegistry
from .models import AutomationEvent, AutomationExecution, AutomationRule, Condition


AuditHook = Callable[[Mapping[str, Any]], Awaitable[None]]


def _read(payload: Mapping[str, Any], path: str) -> Any:
    value: Any = payload
    for part in path.split("."):
        if not isinstance(value, Mapping) or part not in value:
            return None
        value = value[part]
    return value


def matches(payload: Mapping[str, Any], conditions: tuple[Condition, ...]) -> bool:
    for condition in conditions:
        actual = _read(payload, condition.field)
        expected = condition.value
        ok = {"eq": actual == expected, "neq": actual != expected, "contains": expected in actual if isinstance(actual, (str, list, tuple, set)) else False, "gt": actual > expected if actual is not None else False, "lt": actual < expected if actual is not None else False}.get(condition.operator)
        if ok is not True:
            return False
    return True


class AutomationEngine:
    def __init__(self, registry: ToolRegistry, policy: PolicyEngine, policy_contexts: Mapping[str, PermissionContext] | None = None, audit: AuditHook | None = None, clock: Callable[[], float] = time.monotonic):
        self.registry, self.policy, self.policy_contexts, self.audit, self.clock = registry, policy, policy_contexts or {}, audit, clock
        self._rules: dict[UUID, AutomationRule] = {}
        self._processed: set[tuple[UUID, UUID]] = set()
        self._executions: list[AutomationExecution] = []
        self._rate: dict[UUID, deque[float]] = defaultdict(deque)

    def add_rule(self, rule: AutomationRule) -> None:
        self._rules[rule.rule_id] = rule

    def disable(self, rule_id: UUID) -> None:
        rule = self._rules[rule_id]
        self._rules[rule_id] = AutomationRule(**{**rule.__dict__, "enabled": False})

    async def handle(self, event: AutomationEvent) -> tuple[AutomationExecution, ...]:
        out: list[AutomationExecution] = []
        for rule in self._rules.values():
            key = (rule.rule_id, event.event_id)
            if not rule.enabled or rule.owner_id != event.owner_id or rule.trigger_kind != event.kind or key in self._processed or not matches(event.payload, rule.conditions):
                continue
            self._processed.add(key)
            now = self.clock()
            bucket = self._rate[rule.rule_id]
            while bucket and now - bucket[0] >= rule.window_seconds:
                bucket.popleft()
            if len(bucket) >= rule.max_executions:
                execution = AutomationExecution(uuid4(), rule.rule_id, event.event_id, "rate_limited", rule.dry_run, error="RATE_LIMITED")
                self._executions.append(execution)
                await self._audit(rule, event, execution)
                out.append(execution)
                continue
            bucket.append(now)
            results: list[Mapping[str, Any]] = []
            status = "dry_run" if rule.dry_run else "completed"
            error = None
            try:
                for action in rule.actions:
                    # Values originating from event payload are data.  They are
                    # never interpreted as permissions or policy identifiers.
                    args = dict(action.arguments)
                    args.setdefault("event_id", str(event.event_id))
                    call = ToolCall(action.tool_name, args)
                    base_context = self.policy_contexts.get(rule.policy_id)
                    if base_context is None:
                        raise PolicyDenied("automation policy is not registered")
                    context = PermissionContext(actor=f"automation:{rule.rule_id}", scopes=base_context.scopes, project_ids=base_context.project_ids, allow_external_effects=base_context.allow_external_effects, expires_at=base_context.expires_at, policy_id=rule.policy_id)
                    if rule.dry_run:
                        self.registry.authorize(call, context)
                        self.registry.validate(call)
                        results.append({"tool": action.tool_name, "status": "would_execute"})
                    else:
                        results.append(await self.registry.invoke(call, context))
            except Exception as exc:
                status, error = "failed", redact_error(exc)
            execution = AutomationExecution(uuid4(), rule.rule_id, event.event_id, status, rule.dry_run, tuple(results), error)
            self._executions.append(execution)
            await self._audit(rule, event, execution)
            out.append(execution)
        return tuple(out)

    async def _audit(self, rule: AutomationRule, event: AutomationEvent, execution: AutomationExecution) -> None:
        if self.audit:
            await self.audit({"rule_id": str(rule.rule_id), "event_id": str(event.event_id), "status": execution.status, "error": execution.error, "dry_run": execution.dry_run})

    def executions(self) -> tuple[AutomationExecution, ...]:
        return tuple(self._executions)
