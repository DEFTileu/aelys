"""Synthetic fixtures exercise the actual boundary before any provider I/O."""
from __future__ import annotations

from decimal import Decimal
from uuid import uuid4

import pytest
from app.ai.errors import AIError
from app.ai.execution import AIExecutionService
from app.ai.models import (
    ChatMessage,
    ModelSpec,
    ProviderKind,
    ProviderRequest,
    RoutingRequest,
    TaskKind,
    ToolCall,
)
from app.ai.providers import ClaudeAdapter, HttpResponse, OpenRouterAdapter
from app.ai.secrets import AuthenticatedStreamCipher, SecretRef, SecretStore
from app.ai.untrusted import UntrustedData


class RecordingTransport:
    def __init__(self):
        self.payloads = []

    async def post(self, url, *, headers, json):
        self.payloads.append(json)
        return HttpResponse(200, {"content": [{"type": "text", "text": "ok"}], "choices": [{"message": {"content": "ok"}}]})

    async def stream(self, url, *, headers, json):
        self.payloads.append(json)
        yield {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}, "choices": [{"delta": {"content": "ok"}}]}


def adapter_for(adapter_class):
    store = SecretStore(AuthenticatedStreamCipher(b"x" * 32))
    ref = SecretRef("provider", "synthetic")
    store.put(ref, "configured-opaque-credential")
    transport = RecordingTransport()
    return adapter_class(transport, store, ref, "https://provider.invalid"), transport


SENSITIVE = [
    "sk-proj-synthetic123456789", 'api_key="synthetic secret with spaces"',
    '{"refresh_token": "synthetic-refresh-value"}', "password: synthetic-password",
    "пароль: синтетический-пароль", "Authorization: Bearer synthetic.access.token",
    "ghp_1234567890abcdefghijklmnopqrstuvwxyz", "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
    "postgresql://owner:synthetic-password@db.invalid/aelys",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.syntheticSignature123",
    "card 4111 1111 1111 1111", "IBAN: KZ86 125K ZT50 0410 0100",
    "ИИН: 000101000000", "email: owner@example.test", "телефон: +7 (777) 123-45-67",
    "configured-opaque-credential",
]


@pytest.mark.parametrize("adapter_class", [ClaudeAdapter, OpenRouterAdapter])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("sensitive", SENSITIVE)
async def test_sensitive_content_blocks_entire_request_without_transport(adapter_class, stream, sensitive):
    adapter, transport = adapter_for(adapter_class)
    request = ProviderRequest("test-model", (ChatMessage("user", "Summarize this: " + sensitive),), stream=stream)
    with pytest.raises(AIError) as failure:
        if stream:
            _ = [part async for part in adapter.stream(request)]
        else:
            await adapter.complete(request)
    assert failure.value.code == "SENSITIVE_DATA_BLOCKED"
    assert sensitive not in str(failure.value)
    assert transport.payloads == []


@pytest.mark.parametrize("adapter_class", [ClaudeAdapter, OpenRouterAdapter])
@pytest.mark.parametrize("location", ["system", "assistant", "tool", "arguments", "schema", "redacted_retrieval"])
async def test_history_tools_and_redacted_retrieval_cannot_bypass_guard(adapter_class, location):
    adapter, transport = adapter_for(adapter_class)
    secret = "sk-synthetic123456789"
    tools = ()
    if location == "tool":
        messages = (ChatMessage("tool", '{"content": "' + secret + '"}', tool_call_id="call-1"),)
    elif location == "arguments":
        messages = (ChatMessage("assistant", "", tool_calls=(ToolCall("draft_mail", {"nested": [{"value": secret}]}, "call-1"),)),)
    elif location == "schema":
        messages = (ChatMessage("user", "hello"),)
        tools = ({"name": "test", "description": secret},)
    elif location == "redacted_retrieval":
        messages = (ChatMessage("user", UntrustedData("note", secret).as_context()),)
    else:
        messages = (ChatMessage(location, secret), ChatMessage("user", "hello"))
    with pytest.raises(AIError) as failure:
        await adapter.complete(ProviderRequest("test-model", messages, tools=tools))
    assert failure.value.code == "SENSITIVE_DATA_BLOCKED"
    assert transport.payloads == []


@pytest.mark.parametrize("adapter_class", [ClaudeAdapter, OpenRouterAdapter])
@pytest.mark.parametrize("stream", [False, True])
async def test_safe_request_preserves_tools_and_credential_header(adapter_class, stream):
    adapter, transport = adapter_for(adapter_class)
    request = ProviderRequest("test-model", (ChatMessage("user", "Напомни завтра в 18:00 купить хлеб. Budget 1234.56 KZT; task 123456789012."),), tools=({"name": "list_tasks", "input_schema": {"type": "object"}},), stream=stream)
    if stream:
        assert [part async for part in adapter.stream(request)] == ["ok"]
    else:
        assert (await adapter.complete(request)).text == "ok"
    assert len(transport.payloads) == 1
    assert transport.payloads[0]["tools"]


async def test_secret_property_with_boolean_schema_default_is_not_misclassified():
    adapter, transport = adapter_for(ClaudeAdapter)
    request = ProviderRequest("test-model", (ChatMessage("user", "Use the example tool"),), tools=(
        {"name": "example", "input_schema": {"type": "object", "properties": {
            "secret": {"type": "boolean", "default": False},
        }}},
    ))
    await adapter.complete(request)
    assert len(transport.payloads) == 1


@pytest.mark.parametrize("value", [
    {"password": {"value": "correct-horse-battery-staple"}},
    {"api_key": ["ordinary-looking-secret-value"]},
])
async def test_nested_labeled_secret_blocks_whole_payload(value):
    from app.ai.egress import ensure_safe_payload

    with pytest.raises(AIError) as failure:
        ensure_safe_payload(value)
    assert failure.value.code == "SENSITIVE_DATA_BLOCKED"


async def test_execution_reports_safe_typed_failure_and_records_no_usage():
    adapter, transport = adapter_for(ClaudeAdapter)
    model = ModelSpec(ProviderKind.CLAUDE, "test-model", frozenset(), 4096, Decimal(0), Decimal(0))
    service = AIExecutionService([model], {ProviderKind.CLAUDE: adapter})
    messages = (ChatMessage("user", "password=synthetic-password"),)
    events = "".join([event async for event in service.stream_sse(uuid4(), RoutingRequest(TaskKind.UNKNOWN), messages)])
    assert '"code":"SENSITIVE_DATA_BLOCKED"' in events
    assert "synthetic-password" not in events
    assert "ai.text.delta" not in events
    assert transport.payloads == []
    assert service.usage.total() == 0


async def test_streaming_completion_blocks_before_emitting_text_or_opening_transport():
    adapter, transport = adapter_for(ClaudeAdapter)
    model = ModelSpec(ProviderKind.CLAUDE, "test-model", frozenset(), 4096, Decimal(0), Decimal(0))
    service = AIExecutionService([model], {ProviderKind.CLAUDE: adapter})
    emitted = []

    async def on_text(delta):
        emitted.append(delta)

    with pytest.raises(AIError) as failure:
        await service.complete(uuid4(), RoutingRequest(TaskKind.UNKNOWN),
            (ChatMessage("user", "email: owner@example.test"),), on_text=on_text)
    assert failure.value.code == "SENSITIVE_DATA_BLOCKED"
    assert emitted == []
    assert transport.payloads == []


async def test_resource_uuid_is_not_mistaken_for_iban():
    adapter, transport = adapter_for(ClaudeAdapter)
    request = ProviderRequest("test-model", (ChatMessage("tool", '{"id":"ab12cdef-1234-4567-8901-123456789abc"}', tool_call_id="call-1"),))
    assert (await adapter.complete(request)).text == "ok"
    assert len(transport.payloads) == 1


@pytest.mark.parametrize("content", [
    '{"password":"synthetic-password"}',
    '{"content":"\\u0073\\u006b-synthetic123456789"}',
    'sk-synthetic\u200b123456789',
    'ｓｋ-synthetic123456789',
])
async def test_structured_and_unicode_content_cannot_hide_sensitive_values(content):
    adapter, transport = adapter_for(OpenRouterAdapter)
    with pytest.raises(AIError) as failure:
        await adapter.complete(ProviderRequest("test-model", (ChatMessage("tool", content, tool_call_id="call-1"),)))
    assert failure.value.code == "SENSITIVE_DATA_BLOCKED"
    assert transport.payloads == []


@pytest.mark.parametrize("stream", [False, True])
async def test_execution_blocks_before_calling_an_injected_adapter(stream):
    class NeverCalledAdapter:
        kind = ProviderKind.CLAUDE

        async def complete(self, request):
            pytest.fail("sensitive request reached adapter")

        async def stream(self, request):
            pytest.fail("sensitive request reached adapter")
            yield "unreachable"

    model = ModelSpec(ProviderKind.CLAUDE, "test-model", frozenset(), 4096, Decimal(0), Decimal(0))
    service = AIExecutionService([model], {ProviderKind.CLAUDE: NeverCalledAdapter()})
    messages = (ChatMessage("system", "password=synthetic-password"), ChatMessage("user", "hello"))
    if stream:
        events = "".join([event async for event in service.stream_sse(uuid4(), RoutingRequest(TaskKind.UNKNOWN), messages)])
        assert '"code":"SENSITIVE_DATA_BLOCKED"' in events
    else:
        with pytest.raises(AIError) as failure:
            await service.complete(uuid4(), RoutingRequest(TaskKind.UNKNOWN), messages)
        assert failure.value.code == "SENSITIVE_DATA_BLOCKED"


async def test_untrusted_memory_is_checked_before_redaction():
    adapter, transport = adapter_for(ClaudeAdapter)
    model = ModelSpec(ProviderKind.CLAUDE, "test-model", frozenset(), 4096, Decimal(0), Decimal(0))
    service = AIExecutionService([model], {ProviderKind.CLAUDE: adapter})
    # Verify raw memory text is checked before untrusted-boundary redaction.
    messages = (ChatMessage("user", "password=synthetic-memory-secret", untrusted=True,
                            memory_refs=(("synthetic-memory", 1),)),)
    with pytest.raises(AIError) as failure:
        await service.complete(uuid4(), RoutingRequest(TaskKind.UNKNOWN), messages)
    assert failure.value.code == "SENSITIVE_DATA_BLOCKED"
    assert transport.payloads == []


async def test_sensitive_tool_result_blocks_followup_in_shared_turn():
    from app.ai.models import PermissionContext
    from app.ai.policy import ServerPolicyEngine
    from app.ai.tools import ToolDescriptor, ToolRegistry
    from app.ai.turn import run_tool_turn

    adapter, transport = adapter_for(ClaudeAdapter)
    model = ModelSpec(ProviderKind.CLAUDE, "test-model", frozenset(), 4096, Decimal(0), Decimal(0))
    service = AIExecutionService([model], {ProviderKind.CLAUDE: adapter})
    calls = 0

    async def provider_post(url, *, headers, json):
        nonlocal calls
        calls += 1
        if calls == 1:
            return HttpResponse(200, {"content": [{"type": "tool_use", "id": "call-1",
                "name": "lookup", "input": {}}]})
        pytest.fail("sensitive tool result reached provider")

    transport.post = provider_post
    registry = ToolRegistry(ServerPolicyEngine())

    async def lookup(_args):
        return {"value": "password=synthetic-tool-result-secret"}

    registry.register(ToolDescriptor("lookup", "Lookup", "lookup", lambda value: value, lookup))
    with pytest.raises(AIError) as failure:
        await run_tool_turn(service, uuid4(), RoutingRequest(TaskKind.TOOL_ACTION),
            (ChatMessage("user", "Look this up"),), registry,
            PermissionContext(actor="test", scopes=frozenset({"lookup"})),
            parse_call=lambda raw: ToolCall(raw["name"], raw["input"], raw["id"]), max_steps=2)
    assert failure.value.code == "SENSITIVE_DATA_BLOCKED"
    assert calls == 1


@pytest.mark.parametrize("provider_name", ["ClaudeProvider", "OpenRouterProvider"])
async def test_legacy_provider_facade_cannot_bypass_egress(provider_name):
    from app.ai import service

    async def transport(*args):
        pytest.fail("sensitive request reached legacy transport")

    store = service.EncryptedMemorySecretStore(b"x" * 32)
    store.put("test", "opaque-credential")
    provider = getattr(service, provider_name)(transport, store, "test")
    model = service.Model("test", "test-model", frozenset(), Decimal(0))
    with pytest.raises(AIError) as failure:
        _ = [part async for part in provider.stream(model, [{"role": "user", "content": "password=synthetic-password"}])]
    assert failure.value.code == "SENSITIVE_DATA_BLOCKED"


async def test_legacy_model_identifier_cannot_disclose_sensitive_content():
    from app.ai import service

    async def transport(*args):
        return ["transport was called"]

    store = service.EncryptedMemorySecretStore(b"x" * 32)
    store.put("test", "opaque-credential")
    provider = service.ClaudeProvider(transport, store, "test")
    model = service.Model("test", "sk-synthetic123456789", frozenset(), Decimal(0))
    with pytest.raises(AIError) as failure:
        _ = [part async for part in provider.stream(model, [{"role": "user", "content": "hello"}])]
    assert failure.value.code == "SENSITIVE_DATA_BLOCKED"
