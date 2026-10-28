"""Server side authorization for AI and automation tool calls."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol

from .errors import PolicyDenied
from .models import PermissionContext, ToolCall


class PolicyEngine(Protocol):
    def authorize(self, tool: "ToolDescriptor", call: ToolCall, context: PermissionContext) -> None: ...


class ToolDescriptor(Protocol):
    name: str
    required_scope: str
    external_effect: bool


class ServerPolicyEngine:
    def authorize(self, tool: ToolDescriptor, call: ToolCall, context: PermissionContext) -> None:
        if context.expires_at and context.expires_at <= datetime.now(timezone.utc):
            raise PolicyDenied("policy expired")
        if tool.required_scope not in context.scopes:
            raise PolicyDenied("tool scope is not granted")
        if tool.external_effect and not context.allow_external_effects:
            raise PolicyDenied("external effects require explicit permission")
        project_id = call.arguments.get("project_id")
        if project_id is not None and str(project_id) not in context.project_ids:
            raise PolicyDenied("project is outside the granted scope")
