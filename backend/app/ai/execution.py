"""Provider execution boundary.

This module is deliberately transport- and storage-agnostic. The FastAPI layer
can inject configured adapters and a SecretStore; no provider key or retrieved
local-session excerpt is written here or returned in events.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol
from uuid import UUID

from .errors import AIError, BudgetExceeded, ProviderError, RunCancelled, redact_error
from .models import (
    ChatMessage,
    ModelSpec,
    ProviderKind,
    ProviderRequest,
    ProviderResponse,
    RoutingRequest,
    Usage,
)
from .router import ModelRouter
from .usage import UsageRecord, UsageTracker


class Adapter(Protocol):
    kind: ProviderKind
    async def complete(self, request: ProviderRequest) -> ProviderResponse: ...
    def stream(self, request: ProviderRequest) -> AsyncIterator[str]: ...


@dataclass(frozen=True)
class ExecutionResult:
    run_id: UUID
    provider: ProviderKind
    model: str
    response: ProviderResponse
    usage: UsageRecord


class AIExecutionService:
    def __init__(self, models: list[ModelSpec], adapters: Mapping[ProviderKind, Adapter], *, monthly_remaining: Decimal = Decimal("100.00"), usage: UsageTracker | None = None):
        self.models = tuple(models)
        self.adapters = dict(adapters)
        self.usage = usage or UsageTracker()
        self.router = ModelRouter(self.models, monthly_remaining=monthly_remaining)

    def select(self, request: RoutingRequest):
        return self.router.choose(request)

    async def complete(self, run_id: UUID, request: RoutingRequest, messages: tuple[ChatMessage, ...], *, max_tokens: int = 1024, tools: tuple[Mapping[str, object], ...] = (), cancel: asyncio.Event | None = None) -> ExecutionResult:
        decision = self.select(request)
        adapter = self.adapters.get(decision.provider)
        if adapter is None:
            raise ProviderError("configured provider adapter is unavailable")
        if cancel and cancel.is_set():
            raise RunCancelled("run cancelled")
        response = await adapter.complete(ProviderRequest(decision.model, messages, max_tokens=max_tokens, tools=tools))
        if cancel and cancel.is_set():
            raise RunCancelled("run cancelled")
        usage = self.usage.record(run_id, decision.provider, next(m for m in self.models if m.provider == decision.provider and m.model == decision.model), response.usage)
        return ExecutionResult(run_id, decision.provider, decision.model, response, usage)

    async def stream_sse(self, run_id: UUID, request: RoutingRequest, messages: tuple[ChatMessage, ...], *, max_tokens: int = 1024, cancel: asyncio.Event | None = None, cancel_check: Callable[[], Awaitable[bool]] | None = None) -> AsyncIterator[str]:
        async def cancelled() -> bool:
            return bool(cancel and cancel.is_set()) or bool(cancel_check and await cancel_check())

        try:
            decision = self.select(request)
            adapter = self.adapters.get(decision.provider)
            if adapter is None:
                raise ProviderError("configured provider adapter is unavailable")
            if await cancelled():
                raise RunCancelled("run cancelled")
            yield self._event("ai.run.started", {"run_id": str(run_id), "provider": decision.provider.value, "model": decision.model})
            text = []
            async for chunk in adapter.stream(ProviderRequest(decision.model, messages, max_tokens=max_tokens, stream=True)):
                if await cancelled():
                    raise RunCancelled("run cancelled")
                text.append(chunk)
                yield self._event("ai.text.delta", {"run_id": str(run_id), "text": chunk})
            if await cancelled():
                raise RunCancelled("run cancelled")
            model = next(m for m in self.models if m.provider == decision.provider and m.model == decision.model)
            # Streaming providers may report usage only in a terminal frame. The
            # conservative zero-count record avoids inventing cost data.
            usage = self.usage.record(run_id, decision.provider, model, getattr(adapter, "last_usage", Usage()))
            yield self._event("ai.run.completed", {"run_id": str(run_id), "text_length": len("".join(text)), "estimated_cost": str(usage.estimated_cost)})
        except RunCancelled:
            yield self._event("ai.run.cancelled", {"run_id": str(run_id)})
        except (AIError, BudgetExceeded) as exc:
            yield self._event("ai.run.failed", {"run_id": str(run_id), "code": getattr(exc, "code", "AI_ERROR"), "message": redact_error(exc)})
        except Exception as exc:  # noqa: BLE001 - untrusted adapters terminate runs through redacted events
            yield self._event("ai.run.failed", {"run_id": str(run_id), "code": "AI_ERROR", "message": redact_error(exc)})

    @staticmethod
    def _event(event: str, payload: dict[str, object]) -> str:
        return f"event: {event}\ndata: {json.dumps(payload, separators=(',', ':'), ensure_ascii=False)}\n\n"
