"""Typed tool registry with policy interception and redacted failures."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping

from .errors import ToolValidationError, redact_error
from .models import PermissionContext, ToolCall
from .policy import PolicyEngine


Validator = Callable[[Mapping[str, Any]], Mapping[str, Any]]
Handler = Callable[[Mapping[str, Any]], Awaitable[Mapping[str, Any]]]


@dataclass
class ToolDescriptor:
    name: str
    description: str
    required_scope: str
    validator: Validator
    handler: Handler
    external_effect: bool = False


class ToolRegistry:
    def __init__(self, policy: PolicyEngine):
        self._policy = policy
        self._tools: dict[str, ToolDescriptor] = {}

    def register(self, descriptor: ToolDescriptor) -> None:
        if descriptor.name in self._tools:
            raise ValueError(f"duplicate tool: {descriptor.name}")
        self._tools[descriptor.name] = descriptor

    def schemas(self) -> tuple[dict[str, str], ...]:
        return tuple({"name": t.name, "description": t.description} for t in self._tools.values())

    def descriptor(self, name: str) -> ToolDescriptor:
        descriptor = self._tools.get(name)
        if descriptor is None:
            raise ToolValidationError("unknown tool")
        return descriptor

    def validate(self, call: ToolCall) -> Mapping[str, Any]:
        descriptor = self.descriptor(call.name)
        try:
            return descriptor.validator(call.arguments)
        except Exception as exc:
            raise ToolValidationError(redact_error(exc)) from None

    def authorize(self, call: ToolCall, context: PermissionContext) -> None:
        self._policy.authorize(self.descriptor(call.name), call, context)

    async def invoke(self, call: ToolCall, context: PermissionContext) -> Mapping[str, Any]:
        descriptor = self.descriptor(call.name)
        self.authorize(call, context)
        args = self.validate(call)
        try:
            return await descriptor.handler(args)
        except Exception as exc:
            raise RuntimeError(f"tool failed: {redact_error(exc)}") from None
