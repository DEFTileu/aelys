"""Direct HTTP provider adapters with injectable transports."""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from typing import Any, Protocol

from .egress import ensure_safe_payload
from .errors import ProviderError, RunCancelled, redact_error
from .models import ChatMessage, ProviderKind, ProviderRequest, ProviderResponse, Usage
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


def _streamed_usage(request: ProviderRequest, usage: Usage, output: str) -> Usage:
    # shortcut: chars/4 when a stream omits usage, so the budget never sees zero; drop once both providers always report it.
    if usage.input_tokens and usage.output_tokens:
        return usage
    return Usage(usage.input_tokens or sum(len(m.content) for m in request.messages) // 4,
                 usage.output_tokens or len(output) // 4)


def _arguments(raw: str) -> Mapping[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except ValueError:
        raise ProviderError("provider stream returned invalid tool arguments") from None
    if not isinstance(value, dict):
        raise ProviderError("provider stream returned invalid tool arguments")
    return value


def _content(message: ChatMessage, *, claude: bool) -> str | list[dict[str, Any]]:
    if not message.media:
        return message.content
    parts: list[dict[str, Any]] = []
    if message.content:
        parts.append({"type": "text", "text": message.content})
    for media in message.media:
        encoded = base64.b64encode(media.data).decode("ascii")
        if claude:
            parts.append({"type": "document" if media.mime_type == "application/pdf" else "image",
                          "source": {"type": "base64", "media_type": media.mime_type, "data": encoded}})
        elif media.mime_type == "application/pdf":
            parts.append({"type": "file", "file": {"filename": media.filename,
                          "file_data": f"data:application/pdf;base64,{encoded}"}})
        else:
            parts.append({"type": "image_url", "image_url": {"url": f"data:{media.mime_type};base64,{encoded}"}})
    return parts


def _claude_messages(messages: tuple[ChatMessage, ...]) -> list[dict[str, Any]]:
    # Thinking blocks are not replayed: Claude accepts tool turns without them, and a replayed
    # block breaks with 400 as soon as an earlier message changes (memory refresh can drop one).
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.role == "system":
            continue
        if m.role == "tool":
            block = {"type": "tool_result", "tool_use_id": m.tool_call_id, "content": m.content}
            previous = out[-1]["content"] if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list) else None
            if previous and previous[-1].get("type") == "tool_result":
                previous.append(block)  # all results of one assistant turn go back in one user message
            else:
                out.append({"role": "user", "content": [block]})
        elif m.tool_calls:
            out.append({"role": "assistant", "content": [*([{"type": "text", "text": m.content}] if m.content else []),
                        *({"type": "tool_use", "id": c.call_id, "name": c.name, "input": dict(c.arguments)} for c in m.tool_calls)]})
        else:
            out.append({"role": m.role, "content": _content(m, claude=True)})
    return out


def _openai_messages(messages: tuple[ChatMessage, ...]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.role == "tool":
            out.append({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content})
            continue
        item: dict[str, Any] = {"role": m.role, "content": _content(m, claude=False)}
        if m.tool_calls:
            item["tool_calls"] = [{"id": c.call_id, "type": "function", "function": {"name": c.name, "arguments": json.dumps(dict(c.arguments), ensure_ascii=False, default=str)}} for c in m.tool_calls]
        out.append(item)
    return out


class _BaseAdapter:
    def __init__(self, transport: HttpTransport, secrets: SecretStore, secret_ref: SecretRef, base_url: str):
        self._transport, self._secrets, self._ref, self._base_url = transport, secrets, secret_ref, base_url.rstrip("/")
        self.last_usage = Usage()

    def _headers(self) -> dict[str, str]:
        return {"content-type": "application/json", "authorization": f"Bearer {self._secrets._resolve_for_provider_call(self._ref)}"}

    def _check_payload(self, payload: Mapping[str, Any]) -> None:
        ensure_safe_payload(
            payload,
            known_secrets=(self._secrets._resolve_for_provider_call(self._ref),),
        )

    async def _post(self, path: str, payload: Mapping[str, Any], *, media: bool = False) -> HttpResponse:
        self._check_payload(payload)
        try:
            response = await self._transport.post(self._base_url + path, headers=self._headers(), json=payload)
        except RunCancelled:
            raise
        except Exception as exc:  # noqa: BLE001 - provider implementations expose only sanitized failures
            if media:
                # Even a transport exception may echo the inline binary payload.
                raise ProviderError("provider media request failed") from None
            raise ProviderError(f"provider request failed: {redact_error(exc)}") from None
        if response.status >= 400:
            raise ProviderError(f"provider returned status {response.status}")
        return response

    async def _stream(self, path: str, payload: Mapping[str, Any], *, media: bool = False) -> AsyncIterator[Mapping[str, Any]]:
        self._check_payload(payload)
        try:
            async for item in self._transport.stream(self._base_url + path, headers=self._headers(), json=payload):
                yield item
        except RunCancelled:
            raise
        except Exception:  # Raw media/base64 must never enter error events or logs.
            if media:
                raise ProviderError("provider media stream failed") from None
            raise


CLAUDE_MIN_MAX_TOKENS = 16000


class ClaudeAdapter(_BaseAdapter):
    kind = ProviderKind.CLAUDE

    def _headers(self) -> dict[str, str]:
        return {"content-type":"application/json","x-api-key":self._secrets._resolve_for_provider_call(self._ref),"anthropic-version":"2023-06-01"}

    def _payload(self, request: ProviderRequest) -> dict[str, Any]:
        system = [m.content for m in request.messages if m.role == "system"]
        messages = _claude_messages(request.messages)
        # Current Claude models reject sampling params and thinking budgets with 400; effort is the only control.
        # Thinking is on by default and counts against max_tokens, so leave it room.
        payload = {"model": request.model, "max_tokens": max(request.max_tokens, CLAUDE_MIN_MAX_TOKENS), "messages": messages, "stream": request.stream, **({"system": "\n".join(system)} if system else {}), **({"tools": list(request.tools)} if request.tools else {})}
        # Caches the prompt up to the last block, so the next tool step or chat turn skips re-reading it (from 512 tokens).
        payload["cache_control"] = {"type": "ephemeral"}
        if request.effort:
            payload["thinking"] = {"type": "adaptive"}
            payload["output_config"] = {"effort": request.effort}
        return payload

    async def complete(self, request: ProviderRequest) -> ProviderResponse:
        response = await self._post("/v1/messages", self._payload(request), media=any(m.media for m in request.messages))
        self.last_usage = _usage(response.body)
        content = response.body.get("content", [])
        text = "".join(str(part.get("text", "")) for part in content if isinstance(part, Mapping) and part.get("type") == "text")
        calls = tuple(part for part in content if isinstance(part, Mapping) and part.get("type") == "tool_use")
        return ProviderResponse(text, _usage(response.body), response.body.get("id"), calls)

    async def stream(self, request: ProviderRequest) -> AsyncIterator[str]:
        self.last_usage = Usage()
        async for item in self._stream("/v1/messages", self._payload(request), media=any(m.media for m in request.messages)):
            if item.get("type") == "error" or item.get("error"):
                raise ProviderError("provider stream failed")
            if item.get("usage"):
                self.last_usage = _usage(item)
            if item.get("type") == "content_block_delta":
                delta = item.get("delta", {})
                if delta.get("type") == "text_delta":
                    yield str(delta.get("text", ""))

    async def complete_streaming(self, request: ProviderRequest, on_text: Callable[[str], Awaitable[None]]) -> ProviderResponse:
        """Same result as complete(), with text deltas reported while the model writes."""
        text: list[str] = []
        tools: dict[int, dict[str, Any]] = {}
        usage, request_id, finished = Usage(), None, False
        async for item in self._stream("/v1/messages", self._payload(replace(request, stream=True)), media=any(m.media for m in request.messages)):
            kind = item.get("type")
            if kind == "error" or item.get("error"):
                raise ProviderError("provider stream failed")
            if kind == "message_start":
                message = item.get("message") or {}
                request_id, usage = message.get("id"), _usage(message)
            elif kind == "message_delta" and item.get("usage"):
                delta_usage = _usage(item)
                usage = Usage(max(usage.input_tokens, delta_usage.input_tokens), max(usage.output_tokens, delta_usage.output_tokens))
            elif kind == "content_block_start":
                block = item.get("content_block") or {}
                if block.get("type") == "tool_use":
                    tools[int(item.get("index", len(tools)))] = {"id": block.get("id"), "name": block.get("name"), "json": []}
            elif kind == "content_block_delta":
                delta = item.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    text.append(str(delta["text"]))
                    await on_text(text[-1])
                elif delta.get("type") == "input_json_delta" and int(item.get("index", -1)) in tools:
                    tools[int(item["index"])]["json"].append(str(delta.get("partial_json", "")))
            elif kind == "message_stop":
                finished = True
        if not finished:
            raise ProviderError("provider stream ended early")
        calls = tuple({"type": "tool_use", "id": tool["id"], "name": tool["name"], "input": _arguments("".join(tool["json"]))}
                      for _, tool in sorted(tools.items()))
        self.last_usage = _streamed_usage(request, usage, "".join(text) + json.dumps(calls, default=str))
        return ProviderResponse("".join(text), self.last_usage, request_id, calls)


class OpenRouterAdapter(_BaseAdapter):
    kind = ProviderKind.OPENROUTER

    def _payload(self, request: ProviderRequest) -> dict[str, Any]:
        tools = [{"type": "function", "function": {"name": str(tool["name"]), "description": str(tool.get("description", "")), "parameters": tool.get("input_schema") or {"type": "object"}}} for tool in request.tools]
        return {"model": request.model, "messages": _openai_messages(request.messages), "max_tokens": request.max_tokens, "temperature": float(request.temperature), "stream": request.stream, **({"tools": tools} if tools else {}), **({"reasoning": {"effort": request.effort}} if request.effort else {})}

    async def complete(self, request: ProviderRequest) -> ProviderResponse:
        response = await self._post("/api/v1/chat/completions", self._payload(request), media=any(m.media for m in request.messages))
        self.last_usage = _usage(response.body)
        choices = response.body.get("choices", [])
        message = choices[0].get("message", {}) if choices else {}
        return ProviderResponse(str(message.get("content", "")), _usage(response.body), response.body.get("id"), tuple(message.get("tool_calls", ())))

    async def stream(self, request: ProviderRequest) -> AsyncIterator[str]:
        self.last_usage = Usage()
        async for item in self._stream("/api/v1/chat/completions", self._payload(request), media=any(m.media for m in request.messages)):
            if item.get("error"):
                raise ProviderError("provider stream failed")
            if item.get("usage"):
                self.last_usage = _usage(item)
            choices = item.get("choices", [])
            delta = choices[0].get("delta", {}) if choices else {}
            if delta.get("content"):
                yield str(delta["content"])

    async def complete_streaming(self, request: ProviderRequest, on_text: Callable[[str], Awaitable[None]]) -> ProviderResponse:
        """Same result as complete(), with text deltas reported while the model writes."""
        text: list[str] = []
        tools: dict[int, dict[str, Any]] = {}
        usage, request_id, finished = Usage(), None, False
        payload = {**self._payload(replace(request, stream=True)), "stream_options": {"include_usage": True}}
        async for item in self._stream("/api/v1/chat/completions", payload, media=any(m.media for m in request.messages)):
            if item.get("error"):
                raise ProviderError("provider stream failed")
            request_id = request_id or item.get("id")
            if item.get("usage"):
                usage = _usage(item)
            choices = item.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            if delta.get("content"):
                text.append(str(delta["content"]))
                await on_text(text[-1])
            for part in delta.get("tool_calls") or ():
                tool = tools.setdefault(int(part.get("index", len(tools))), {"id": None, "name": "", "arguments": []})
                function = part.get("function") or {}
                tool["id"] = part.get("id") or tool["id"]
                tool["name"] = function.get("name") or tool["name"]
                tool["arguments"].append(str(function.get("arguments") or ""))
            finished = finished or bool(choices[0].get("finish_reason"))
        if not finished:
            raise ProviderError("provider stream ended early")
        calls = tuple({"id": tool["id"], "type": "function", "function": {"name": tool["name"], "arguments": json.dumps(_arguments("".join(tool["arguments"])), ensure_ascii=False)}}
                      for _, tool in sorted(tools.items()))
        self.last_usage = _streamed_usage(request, usage, "".join(text) + json.dumps(calls, default=str))
        return ProviderResponse("".join(text), self.last_usage, request_id, calls)
