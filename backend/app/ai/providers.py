"""Direct HTTP provider adapters with injectable transports."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator, Mapping, Protocol

from .errors import ProviderError, redact_error
from .models import ProviderRequest, ProviderResponse, ProviderKind, Usage
from .secrets import SecretRef, SecretStore


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: Mapping[str, Any]


class HttpTransport(Protocol):
    async def post(self, url: str, *, headers: Mapping[str, str], json: Mapping[str, Any]) -> HttpResponse: ...
    def stream(self, url: str, *, headers: Mapping[str, str], json: Mapping[str, Any]) -> AsyncIterator[Mapping[str, Any]]: ...


class ProviderAdapter(Protocol):
    kind: ProviderKind
    async def complete(self, request: ProviderRequest) -> ProviderResponse: ...
    def stream(self, request: ProviderRequest) -> AsyncIterator[str]: ...


def _usage(body: Mapping[str, Any]) -> Usage:
    u = body.get("usage") or {}
    return Usage(int(u.get("input_tokens", u.get("prompt_tokens", 0)) or 0), int(u.get("output_tokens", u.get("completion_tokens", 0)) or 0))


class _BaseAdapter:
    def __init__(self, transport: HttpTransport, secrets: SecretStore, secret_ref: SecretRef, base_url: str):
        self._transport, self._secrets, self._ref, self._base_url = transport, secrets, secret_ref, base_url.rstrip("/")
        self.last_usage = Usage()

    def _headers(self) -> dict[str, str]:
        return {"content-type": "application/json", "authorization": f"Bearer {self._secrets._resolve_for_provider_call(self._ref)}"}

    async def _post(self, path: str, payload: Mapping[str, Any]) -> HttpResponse:
        try:
            response = await self._transport.post(self._base_url + path, headers=self._headers(), json=payload)
        except Exception as exc:
            raise ProviderError(f"provider request failed: {redact_error(exc)}") from None
        if response.status >= 400:
            raise ProviderError(f"provider returned status {response.status}")
        return response


class ClaudeAdapter(_BaseAdapter):
    kind = ProviderKind.CLAUDE

    def _headers(self) -> dict[str, str]:
        return {"content-type":"application/json","x-api-key":self._secrets._resolve_for_provider_call(self._ref),"anthropic-version":"2023-06-01"}

    def _payload(self, request: ProviderRequest) -> dict[str, Any]:
        system = [m.content for m in request.messages if m.role == "system"]
        messages = [{"role": m.role, "content": m.content} for m in request.messages if m.role != "system"]
        return {"model": request.model, "max_tokens": request.max_tokens, "temperature": float(request.temperature), "messages": messages, "stream": request.stream, **({"system": "\n".join(system)} if system else {})}

    async def complete(self, request: ProviderRequest) -> ProviderResponse:
        response = await self._post("/v1/messages", self._payload(request))
        self.last_usage = _usage(response.body)
        content = response.body.get("content", [])
        text = "".join(str(part.get("text", "")) for part in content if isinstance(part, Mapping) and part.get("type") == "text")
        calls = tuple(part for part in content if isinstance(part, Mapping) and part.get("type") == "tool_use")
        return ProviderResponse(text, _usage(response.body), response.body.get("id"), calls)

    async def stream(self, request: ProviderRequest) -> AsyncIterator[str]:
        self.last_usage = Usage()
        async for item in self._transport.stream(self._base_url + "/v1/messages", headers=self._headers(), json=self._payload(request)):
            if item.get("usage"):
                self.last_usage = _usage(item)
            if item.get("type") == "content_block_delta":
                delta = item.get("delta", {})
                if delta.get("type") == "text_delta":
                    yield str(delta.get("text", ""))


class OpenRouterAdapter(_BaseAdapter):
    kind = ProviderKind.OPENROUTER

    def _payload(self, request: ProviderRequest) -> dict[str, Any]:
        return {"model": request.model, "messages": [{"role": m.role, "content": m.content} for m in request.messages], "max_tokens": request.max_tokens, "temperature": float(request.temperature), "stream": request.stream}

    async def complete(self, request: ProviderRequest) -> ProviderResponse:
        response = await self._post("/api/v1/chat/completions", self._payload(request))
        self.last_usage = _usage(response.body)
        choices = response.body.get("choices", [])
        message = choices[0].get("message", {}) if choices else {}
        return ProviderResponse(str(message.get("content", "")), _usage(response.body), response.body.get("id"), tuple(message.get("tool_calls", ())))

    async def stream(self, request: ProviderRequest) -> AsyncIterator[str]:
        self.last_usage = Usage()
        async for item in self._transport.stream(self._base_url + "/api/v1/chat/completions", headers=self._headers(), json=self._payload(request)):
            if item.get("usage"):
                self.last_usage = _usage(item)
            choices = item.get("choices", [])
            delta = choices[0].get("delta", {}) if choices else {}
            if delta.get("content"):
                yield str(delta["content"])
