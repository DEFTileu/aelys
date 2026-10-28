"""Compatibility facade for the pre-foundation AI service imports.

New code should import the focused modules in this package. This facade keeps
older callers working without retaining the former untyped provider and secret
implementations.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import AsyncIterator, Protocol, Any

from .secrets import AuthenticatedStreamCipher, SecretRef, SecretStore


class EncryptedMemorySecretStore:
    def __init__(self, key: bytes):
        self._store = SecretStore(AuthenticatedStreamCipher(key))

    def put(self, ref: str, value: str) -> None:
        self._store.put(SecretRef("compat", ref), value)

    def get(self, ref: str) -> str:
        return self._store._resolve_for_provider_call(SecretRef("compat", ref))


@dataclass(frozen=True)
class Model:
    provider: str
    name: str
    capabilities: frozenset[str]
    cost_per_1k: Decimal | float
    privacy: str = "external"


class ModelRouter:
    def choose(self, models: list[Model], task_kind: str = "default", required: frozenset[str] = frozenset(), manual: str | None = None, budget: Decimal | float | None = None, privacy: str = "external") -> Model:
        candidates = [m for m in models if required <= m.capabilities and (privacy == "external" or m.privacy in (privacy, "local")) and (budget is None or Decimal(str(m.cost_per_1k)) <= Decimal(str(budget)))]
        if manual:
            candidates = [m for m in candidates if m.name == manual]
        if not candidates:
            raise ValueError("MODEL_UNAVAILABLE")
        return sorted(candidates, key=lambda m: (0 if task_kind == "reasoning" and "reasoning" in m.capabilities else 1, Decimal(str(m.cost_per_1k)), m.provider, m.name))[0]


class Provider(Protocol):
    def stream(self, model: Model, messages: list[dict[str, str]]) -> AsyncIterator[str]: ...


class ClaudeProvider:
    """Legacy adapter shape; callers should use ``ClaudeAdapter`` directly."""

    def __init__(self, transport: Any, secret_store: EncryptedMemorySecretStore, secret_ref: str):
        self.transport, self.secrets, self.secret_ref = transport, secret_store, secret_ref

    async def stream(self, model: Model, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        response = await self.transport(model.name, messages, self.secrets.get(self.secret_ref))
        for chunk in response:
            yield chunk


class OpenRouterProvider(ClaudeProvider):
    pass


async def sse_events(run_id: str, provider: Provider, model: Model, messages: list[dict[str, str]], cancel: asyncio.Event | None = None) -> AsyncIterator[str]:
    sequence = 0
    yield f"id: {sequence}\nevent: ai.run.started\ndata: {json.dumps({'run_id': run_id})}\n\n"
    try:
        async for text in provider.stream(model, messages):
            if cancel and cancel.is_set():
                raise asyncio.CancelledError
            sequence += 1
            yield f"id: {sequence}\nevent: ai.text.delta\ndata: {json.dumps({'run_id': run_id, 'text': text})}\n\n"
        sequence += 1
        yield f"id: {sequence}\nevent: ai.run.completed\ndata: {json.dumps({'run_id': run_id})}\n\n"
    except asyncio.CancelledError:
        yield f"id: {sequence + 1}\nevent: ai.run.cancelled\ndata: {json.dumps({'run_id': run_id})}\n\n"
