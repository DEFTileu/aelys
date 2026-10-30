from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID


@dataclass(frozen=True)
class AutomationEvent:
    event_id: UUID
    kind: str
    payload: Mapping[str, Any]
    owner_id: str
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass(frozen=True)
class Condition:
    field: str
    operator: str
    value: Any


@dataclass(frozen=True)
class Action:
    tool_name: str
    arguments: Mapping[str, Any]
    required_scope: str


@dataclass(frozen=True)
class AutomationRule:
    rule_id: UUID
    owner_id: str
    name: str
    trigger_kind: str
    conditions: tuple[Condition, ...]
    actions: tuple[Action, ...]
    policy_id: str
    enabled: bool = True
    dry_run: bool = False
    max_executions: int = 60
    window_seconds: int = 3600


@dataclass(frozen=True)
class AutomationExecution:
    execution_id: UUID
    rule_id: UUID
    event_id: UUID
    status: str
    dry_run: bool
    results: tuple[Mapping[str, Any], ...] = ()
    error: str | None = None
