"""Streamed completions return the same result as complete() and report text as it arrives."""
import asyncio
from decimal import Decimal
from uuid import uuid4

import pytest
from app.ai.errors import ProviderError
from app.ai.execution import AIExecutionService
from app.ai.models import (
    Capability,
    ChatMessage,
    ModelSpec,
    PermissionContext,
    PrivacyClass,
    ProviderKind,
    ProviderRequest,
    RoutingRequest,
    TaskKind,
)
from app.ai.providers import ClaudeAdapter, OpenRouterAdapter
from app.ai.secrets import AuthenticatedStreamCipher, SecretRef, SecretStore
from app.ai.tools import ToolRegistry
from app.ai.turn import run_tool_turn


class Transport:
    def __init__(self, *streams):
        self.streams, self.payloads = list(streams), []

    async def post(self, url, *, headers, json):
        raise AssertionError('streaming path must not post')

    async def stream(self, url, *, headers, json):
        self.payloads.append(json)
        for item in self.streams.pop(0):
            yield item


CLAUDE_TOOL = [
    {'type': 'message_start', 'message': {'id': 'm1', 'usage': {'input_tokens': 40, 'output_tokens': 1}}},
    {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
    {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'Создаю '}},
    {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'задачу'}},
    {'type': 'content_block_start', 'index': 1, 'content_block': {'type': 'tool_use', 'id': 'call-1', 'name': 'echo', 'input': {}}},
    {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'input_json_delta', 'partial_json': '{"title": "Мол'}},
    {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'input_json_delta', 'partial_json': 'око"}'}},
    {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}, 'usage': {'output_tokens': 12}},
    {'type': 'message_stop'},
]
CLAUDE_TEXT = [
    {'type': 'message_start', 'message': {'id': 'm2', 'usage': {'input_tokens': 50, 'output_tokens': 1}}},
    {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'Готово'}},
    {'type': 'message_delta', 'usage': {'output_tokens': 3}},
    {'type': 'message_stop'},
]


def store():
    secrets = SecretStore(AuthenticatedStreamCipher(b's' * 32))
    ref = SecretRef('claude', 'stream-test')
    secrets.put(ref, 'sk-synthetic')
    return secrets, ref


def test_claude_stream_returns_text_tool_calls_and_usage():
    secrets, ref = store()
    seen = []

    async def on_text(delta):
        seen.append(delta)

    response = asyncio.run(ClaudeAdapter(Transport(CLAUDE_TOOL), secrets, ref, 'https://claude')
                           .complete_streaming(ProviderRequest('m', (ChatMessage('user', 'hi'),)), on_text))
    assert seen == ['Создаю ', 'задачу'] and response.text == 'Создаю задачу'
    assert response.tool_calls == ({'type': 'tool_use', 'id': 'call-1', 'name': 'echo', 'input': {'title': 'Молоко'}},)
    assert (response.usage.input_tokens, response.usage.output_tokens) == (40, 12)


def test_openrouter_stream_joins_tool_fragments_and_reads_final_usage():
    secrets, ref = store()
    chunks = [
        {'id': 'r1', 'choices': [{'delta': {'content': 'Ок'}}]},
        {'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'c1', 'function': {'name': 'echo', 'arguments': '{"title":'}}]}}]},
        {'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': '"X"}'}}]}, 'finish_reason': 'tool_calls'}]},
        {'choices': [], 'usage': {'prompt_tokens': 7, 'completion_tokens': 4}},
    ]
    transport = Transport(chunks)
    seen = []

    async def on_text(delta):
        seen.append(delta)

    response = asyncio.run(OpenRouterAdapter(transport, secrets, ref, 'https://or')
                           .complete_streaming(ProviderRequest('m', (ChatMessage('user', 'hi'),)), on_text))
    assert seen == ['Ок'] and transport.payloads[0]['stream'] is True
    assert transport.payloads[0]['stream_options'] == {'include_usage': True}
    assert response.tool_calls[0]['id'] == 'c1' and response.tool_calls[0]['function']['name'] == 'echo'
    assert '"X"' in response.tool_calls[0]['function']['arguments']
    assert (response.usage.input_tokens, response.usage.output_tokens) == (7, 4)


@pytest.mark.parametrize('stream', [CLAUDE_TOOL[:-1], [*CLAUDE_TOOL[:5], {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'input_json_delta', 'partial_json': '{"bro'}}, {'type': 'message_stop'}]])
def test_truncated_or_invalid_stream_is_a_provider_error(stream):
    secrets, ref = store()

    async def on_text(_):
        return None

    with pytest.raises(ProviderError):
        asyncio.run(ClaudeAdapter(Transport(stream), secrets, ref, 'https://claude')
                    .complete_streaming(ProviderRequest('m', (ChatMessage('user', 'hi'),)), on_text))


def test_stream_without_usage_still_charges_the_budget():
    secrets, ref = store()
    stream = [{'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'x' * 400}}, {'type': 'message_stop'}]

    async def on_text(_):
        return None

    response = asyncio.run(ClaudeAdapter(Transport(stream), secrets, ref, 'https://claude')
                           .complete_streaming(ProviderRequest('m', (ChatMessage('user', 'y' * 800),)), on_text))
    assert response.usage.input_tokens >= 200 and response.usage.output_tokens >= 100


def test_tool_turn_streams_whole_reply_across_steps():
    secrets, ref = store()
    adapter = ClaudeAdapter(Transport(CLAUDE_TOOL, CLAUDE_TEXT), secrets, ref, 'https://claude')
    spec = ModelSpec(ProviderKind.CLAUDE, 'm', frozenset({Capability.TOOL_CALLING}), 100000, Decimal('0.001'), Decimal('0.001'),
                     privacy_classes=frozenset({PrivacyClass.PERSONAL}))
    service = AIExecutionService([spec], {ProviderKind.CLAUDE: adapter})
    from app.ai.policy import ServerPolicyEngine
    registry = ToolRegistry(ServerPolicyEngine())
    calls = []

    async def echo(arguments):
        calls.append(dict(arguments))
        return {'ok': True}

    from app.ai.tools import ToolDescriptor
    registry.register(ToolDescriptor('echo', 'Echo', 'tasks.write', lambda arguments: arguments, echo,
                                     input_schema={'type': 'object'}))
    previews = []

    async def on_text(text):
        previews.append(text)

    from app.ai.api import _tool_call
    result = asyncio.run(run_tool_turn(
        service, uuid4(), RoutingRequest(TaskKind.TOOL_ACTION, required_capabilities=frozenset({Capability.TOOL_CALLING}),
                                         privacy=PrivacyClass.PERSONAL, request_budget=Decimal(10)),
        (ChatMessage('user', 'Купи молоко'),), registry,
        PermissionContext(actor='t', scopes=frozenset({'tasks.write'}), project_ids=frozenset(), policy_id='t'),
        parse_call=_tool_call, on_text=on_text))
    assert calls == [{'title': 'Молоко'}]
    assert previews == ['Создаю ', 'Создаю задачу', 'Создаю задачу\nГотово']
    assert result.text == previews[-1] and result.input_tokens == 90
