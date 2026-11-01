"""The shared, bounded provider/tool loop for interactive owner runs."""
from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid5

from .errors import BudgetExceeded, RunCancelled
from .execution import AIExecutionService
from .models import ChatMessage, PermissionContext, RoutingRequest, ToolCall
from .tools import ToolRegistry


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


async def run_tool_turn(
    service: AIExecutionService, run_id: UUID, request: RoutingRequest,
    messages: tuple[ChatMessage, ...], registry: ToolRegistry,
    context: PermissionContext, *,
    parse_call: Callable[[Mapping[str, Any]], ToolCall],
    on_event: Callable[[str, Mapping[str, Any]], Awaitable[None]] | None = None,
    on_usage: Callable[[Decimal, int, int], Awaitable[None]] | None = None,
    cancel: asyncio.Event | None = None,
    cancel_check: Callable[[], Awaitable[bool]] | None = None,
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
    input_tokens = output_tokens = 0
    schemas = tuple(schema for schema in registry.schemas()
                    if registry.descriptor(str(schema['name'])).required_scope in context.scopes)

    async def check() -> None:
        if (cancel and cancel.is_set()) or (cancel_check and await cancel_check()):
            raise RunCancelled('run cancelled')

    async def emit(kind: str, **payload: Any) -> None:
        if on_event:
            await on_event(kind, {'run_id': str(run_id), **payload})

    for step in range(1, max_steps + 1):
        await check()
        remaining = request.request_budget - cost
        if remaining <= 0:
            raise BudgetExceeded('Configured AI budget is exhausted')
        completion_id = run_id if step == 1 else uuid5(run_id, f'tool-step:{step}')
        result = await service.complete(completion_id, replace(request, request_budget=remaining),
                                        messages, tools=schemas, cancel=cancel)
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
        for raw_call in result.response.tool_calls:
            call = parse_call(raw_call)
            if call.call_id in seen:
                continue
            seen.add(call.call_id)
            await check()
            await emit('ai.tool.requested', tool=call.name, call_id=call.call_id)
            output = await registry.invoke(call, context)
            await emit('ai.tool.approved', tool=call.name, call_id=call.call_id)
            await emit('ai.tool.result', tool=call.name, call_id=call.call_id, result=output)
            outputs.append(ChatMessage('user', json.dumps({'tool': call.name, 'result': output},
                                                         ensure_ascii=False, default=str), untrusted=True))
        if not outputs or step == max_steps:
            break
        messages = (*messages, *((ChatMessage('assistant', result.response.text),)
                                  if result.response.text else ()), *outputs)
    await check()
    return ToolTurnResult('\n'.join(text), result.provider.value, result.model,
                          input_tokens, output_tokens, cost, step, bool(outputs and step == max_steps))
