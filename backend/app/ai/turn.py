"""The shared, bounded provider/tool loop for interactive owner runs."""
from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field, replace
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid5

from .errors import BudgetExceeded, RunCancelled, ToolValidationError
from .execution import AIExecutionService
from .models import ChatMessage, PermissionContext, RoutingRequest, ToolCall
from .tools import ToolRegistry
from .web_search import WebSearch

_HTTP_URL = re.compile(r'https?://[^\s<>\[\]"\'()]+', re.IGNORECASE)


def _filter_urls(value: str, allowed: tuple[str, ...] = ()) -> str:
    def filter_match(match: re.Match[str]) -> str:
        token = match.group()
        url = token.rstrip('.,;:!?')
        suffix = token[len(url):]
        return (url if url in allowed else '[ссылка скрыта]') + suffix
    return _HTTP_URL.sub(filter_match, value)


@dataclass(frozen=True)
class ToolTurnResult:
    text: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    cost: Decimal
    steps: int
    followup_pending: bool = False
    memory_refs: tuple[tuple[str, int], ...] = field(default=(), repr=False)


async def run_tool_turn(
    service: AIExecutionService, run_id: UUID, request: RoutingRequest,
    messages: tuple[ChatMessage, ...], registry: ToolRegistry,
    context: PermissionContext, *,
    parse_call: Callable[[Mapping[str, Any]], ToolCall],
    on_event: Callable[[str, Mapping[str, Any]], Awaitable[None]] | None = None,
    on_usage: Callable[[Decimal, int, int], Awaitable[None]] | None = None,
    refresh_messages: Callable[[tuple[ChatMessage, ...]], Awaitable[tuple[ChatMessage, ...]]] | None = None,
    cancel: asyncio.Event | None = None,
    cancel_check: Callable[[], Awaitable[bool]] | None = None,
    on_text: Callable[[str], Awaitable[None]] | None = None,
    max_steps: int = 8,
) -> ToolTurnResult:
    """Only server scopes authorize tools; provider results always return as data.

    Event consumers commit a successful tool before another provider wait. A
    repeated call ID within a turn never invokes the handler a second time.
    The Web endpoint can retain its existing single-completion behavior using
    max_steps=1 while sharing precisely the same execution boundary.
    """
    if not 1 <= max_steps <= 8:
        raise ValueError('Tool turn must have between one and eight steps')
    seen: set[str] = set()
    text: list[str] = []
    cost = Decimal(0)
    used_memory_refs: set[tuple[str, int]] = set()
    input_tokens = output_tokens = 0
    search_count = 0
    search_started = False
    search_sources: list[str] = []
    schemas = tuple(schema for schema in registry.schemas()
                    if registry.descriptor(str(schema['name'])).required_scope in context.scopes)

    async def check() -> None:
        if (cancel and cancel.is_set()) or (cancel_check and await cancel_check()):
            raise RunCancelled('run cancelled')

    async def emit(kind: str, **payload: Any) -> None:
        if on_event:
            await on_event(kind, {'run_id': str(run_id), **payload})

    async def search(query: str) -> Mapping[str, Any]:
        nonlocal cost, input_tokens, output_tokens
        remaining = request.request_budget - cost
        if remaining <= 0:
            return {'error': 'BUDGET_EXCEEDED: Search budget exhausted', 'untrusted': True}
        try:
            result = await service.complete(uuid5(run_id, f'web-search:{search_count}'),
                replace(request, request_budget=remaining, context_tokens=0),
                (ChatMessage('system', 'Search the web for the query and summarize the results.'),
                 ChatMessage('user', query)), tools=(), web_search=True)
        except BudgetExceeded:
            return {'error': 'BUDGET_EXCEEDED: Search budget exhausted', 'untrusted': True}
        cost += result.usage.estimated_cost
        input_tokens += result.usage.usage.input_tokens
        output_tokens += result.usage.usage.output_tokens
        if on_usage:
            await on_usage(cost, input_tokens, output_tokens)
        if not result.response.search_used or not result.response.sources:
            return {'error': 'SEARCH_UNAVAILABLE: No search evidence', 'untrusted': True}
        for source in result.response.sources:
            if source not in search_sources and len(search_sources) < 5:
                search_sources.append(source)
        return {'text': _filter_urls(result.response.text[:1200]), 'sources': list(result.response.sources), 'untrusted': True}

    try:
        search_handler = registry.descriptor('web_search').handler
    except ToolValidationError:
        search_handler = None
    if isinstance(search_handler, WebSearch):
        search_handler.execute = search

    for step in range(1, max_steps + 1):
        await check()
        if refresh_messages:
            messages = await refresh_messages(messages)
        completion_refs = tuple(sorted({ref for chat in messages for ref in chat.memory_refs}))
        used_memory_refs.update(completion_refs)
        remaining = request.request_budget - cost
        if remaining <= 0:
            raise BudgetExceeded('Configured AI budget is exhausted')
        completion_id = run_id if step == 1 else uuid5(run_id, f'tool-step:{step}')
        current: list[str] = []

        # Bind this step's buffer explicitly; the callback only runs while this step's completion is awaited.
        async def stream_text(delta: str, current: list[str] = current, search_started: bool = search_started) -> None:
            # The consumer sees the whole reply so far, joined across steps like the final text.
            current.append(delta)
            if on_text:
                full = '\n'.join([*text, ''.join(current)])
                if search_started:
                    full = full[:full.rfind(' ') + 1]
                    full = _filter_urls(full, tuple(search_sources))
                await on_text(full)

        # Only streaming callers pass on_text, so existing services and fakes keep their signature.
        streaming: dict[str, Any] = {'on_text': stream_text} if on_text else {}
        result = await service.complete(completion_id, replace(request, request_budget=remaining),
                                        messages, tools=schemas, cancel=cancel,
                                        **streaming)
        await check()
        cost += result.usage.estimated_cost
        input_tokens += result.usage.usage.input_tokens
        output_tokens += result.usage.usage.output_tokens
        if on_usage:
            await on_usage(cost, input_tokens, output_tokens)
        if step == 1:
            await emit('ai.run.started', provider=result.provider.value, model=result.model)
        if cost > request.request_budget:
            raise BudgetExceeded('Configured AI budget is exhausted')
        if result.response.text:
            text.append(result.response.text)
        outputs: list[ChatMessage] = []
        calls: list[ToolCall] = []
        for raw_call in result.response.tool_calls:
            call = parse_call(raw_call)
            if call.call_id in seen:
                continue
            seen.add(call.call_id)
            await check()
            is_search = call.name == 'web_search' and isinstance(search_handler, WebSearch)
            try:
                descriptor = registry.descriptor(call.name)
            except ToolValidationError:
                descriptor = None
            write = bool(descriptor and (descriptor.required_scope.endswith('.write') or descriptor.required_scope in {'memory.remember', 'memory.forget'}))
            if is_search:
                registry.authorize(call, context)
                search_started = True
                search_count += 1
            query = str(call.arguments.get('query', ''))[:300] if is_search else ''
            await emit('ai.tool.requested', tool=call.name, call_id=call.call_id,
                       **({'query': query} if is_search else {}))
            output: Mapping[str, Any]
            try:
                if search_started and write:
                    output = {'error': 'POLICY_DENIED: Repeat the write request in a new turn', 'untrusted': True}
                elif is_search and search_count > 2:
                    output = {'error': 'POLICY_DENIED: Search limit reached', 'untrusted': True}
                else:
                    output = await registry.invoke(call, context)
            except (ToolValidationError, RuntimeError) as error:
                # Bad arguments or a stale id are the model's to fix; policy denials still end the run.
                output = {'error': str(error)[:300], 'untrusted': True}
            if 'error' not in output:
                await emit('ai.tool.approved', tool=call.name, call_id=call.call_id)
            search_code = str(output.get('error', '')).split(':', 1)[0]
            search_event = ({'error': search_code if search_code in {'POLICY_DENIED', 'BUDGET_EXCEEDED', 'SEARCH_UNAVAILABLE'} else 'TOOL_ERROR'} if 'error' in output else {'status': 'ok'}) if is_search else output
            await emit('ai.tool.result', tool=call.name, call_id=call.call_id,
                       result=search_event,
                       **({'query': query} if is_search else {}))
            calls.append(call)
            outputs.append(ChatMessage('tool', json.dumps(output, ensure_ascii=False, default=str),
                                       untrusted=True, tool_call_id=call.call_id))
        if not outputs or step == max_steps:
            break
        # The model must see its own calls next to their results, or it repeats them on the next step.
        messages = (*messages, ChatMessage('assistant', result.response.text, memory_refs=completion_refs,
                                           tool_calls=tuple(calls)), *outputs)
    await check()
    final_text = '\n'.join(text)
    if search_started:
        final_text = _filter_urls(final_text, tuple(search_sources))
    if search_sources:
        final_text += ('\n' if final_text else '') + 'Источники:\n' + '\n'.join(search_sources)
    if search_started and on_text:
        await on_text(final_text)
    return ToolTurnResult(final_text, result.provider.value, result.model,
                          input_tokens, output_tokens, cost, step, bool(outputs and step == max_steps), tuple(sorted(used_memory_refs)))
