"""Provider neutral types used by the Aelys AI harness.

The module deliberately contains no FastAPI, database, or provider SDK types.  It
is the small contract shared by transports, routing, tools, and run orchestration.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from enum import Enum
from typing import Any
from uuid import UUID, uuid4


class ProviderKind(str, Enum):
    CLAUDE = "claude"
    OPENROUTER = "openrouter"


class PrivacyClass(str, Enum):
    PUBLIC = "public"
    PERSONAL = "personal"
    SENSITIVE = "sensitive"
    LOCAL_ONLY = "local_only"


class TaskKind(str, Enum):
    UNKNOWN = "unknown"
    CLASSIFICATION = "classification"
    SUMMARY = "summary"
    TOOL_ACTION = "tool_action"
    REASONING = "reasoning"
    LOCAL_SESSION = "local_session"


class Capability(str, Enum):
    TOOL_CALLING = "tool_calling"
    JSON_SCHEMA = "json_schema"
    STREAMING = "streaming"
    LONG_CONTEXT = "long_context"
    REASONING = "reasoning"


class RunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class ChatMessage:
    role: str
    content: str
    untrusted: bool = False


@dataclass(frozen=True)
class ProviderRequest:
    model: str
    messages: tuple[ChatMessage, ...]
    max_tokens: int = 1024
    temperature: Decimal = Decimal(0)
    tools: tuple[Mapping[str, Any], ...] = ()
    stream: bool = False


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass(frozen=True)
class ProviderResponse:
    text: str
    usage: Usage = Usage()
    provider_request_id: str | None = None
    tool_calls: tuple[Mapping[str, Any], ...] = ()


@dataclass(frozen=True)
class ModelSpec:
    provider: ProviderKind
    model: str
    capabilities: frozenset[Capability]
    context_tokens: int
    input_cost_per_1k: Decimal
    output_cost_per_1k: Decimal
    enabled: bool = True
    privacy_classes: frozenset[PrivacyClass] = frozenset(
        {PrivacyClass.PUBLIC, PrivacyClass.PERSONAL}
    )


@dataclass(frozen=True)
class RoutingRequest:
    task_kind: TaskKind
    required_capabilities: frozenset[Capability] = frozenset()
    context_tokens: int = 0
    privacy: PrivacyClass = PrivacyClass.PERSONAL
    request_budget: Decimal = Decimal("1.00")
    manual_provider: ProviderKind | None = None
    manual_model: str | None = None
    favorite_model: str | None = None


@dataclass(frozen=True)
class RoutingDecision:
    provider: ProviderKind
    model: str
    reason_codes: tuple[str, ...]
    estimated_cost: Decimal


@dataclass(frozen=True)
class UsageRecord:
    run_id: UUID
    provider: ProviderKind
    model: str
    usage: Usage
    estimated_cost: Decimal
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass(frozen=True)
class ToolCall:
    name: str
    arguments: Mapping[str, Any]
    call_id: str = field(default_factory=lambda: str(uuid4()))


@dataclass(frozen=True)
class PermissionContext:
    actor: str
    scopes: frozenset[str] = frozenset()
    project_ids: frozenset[str] = frozenset()
    allow_external_effects: bool = False
    expires_at: datetime | None = None
    policy_id: str | None = None


@dataclass(frozen=True)
class RunEvent:
    run_id: UUID
    event_type: str
    payload: Mapping[str, Any]
    sequence: int
    event_id: str
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
