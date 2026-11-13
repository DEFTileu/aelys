from decimal import Decimal
from uuid import uuid4

import pytest
from app.ai.errors import BudgetExceeded
from app.ai.execution import AIExecutionService
from app.ai.models import (
    Capability,
    ChatMessage,
    ModelSpec,
    PrivacyClass,
    ProviderKind,
    ProviderRequest,
    RoutingRequest,
    TaskKind,
    Usage,
)
from app.ai.providers import (
    ClaudeAdapter,
    HttpResponse,
    OpenRouterAdapter,
    _streamed_usage,
)
from app.ai.usage import UsageTracker


class SyntheticTransport:
    def __init__(self, body, status=200):
        self.body = body
        self.status = status
        self.calls = []

    async def post(self, url, *, headers, json):
        self.calls.append((url, headers, json))
        return HttpResponse(self.status, self.body)

    async def stream(self, url, *, headers, json):
        raise AssertionError("stream is not used by Business commands")


class SyntheticSecrets:
    def _resolve_for_provider_call(self, _ref):
        return "secret-test-value"


def adapter(adapter_type, transport):
    instance = object.__new__(adapter_type)
    instance._transport = transport
    instance._secrets = SyntheticSecrets()
    instance._ref = object()
    instance._base_url = "https://provider.invalid"
    instance.last_usage = Usage()
    return instance


@pytest.mark.asyncio
async def test_claude_search_uses_bounded_hosted_tool_and_extracts_actual_sources():
    transport = SyntheticTransport({
        "id": "msg-1",
        "content": [
            {"type": "text", "text": "Answer from current sources."},
            {"type": "web_search_tool_result", "content": [
                {"type": "web_search_result", "url": "https://example.org/a"},
                {"type": "web_search_result", "url": "http://docs.example.org/b"},
                {"type": "web_search_result", "url": "https://example.org/c"},
            ]},
            {"type": "text", "text": "Not a source: https://fabricated.invalid"},
        ],
        "usage": {"input_tokens": 10, "output_tokens": 5,
                   "server_tool_use": {"web_search_requests": 2}},
    })
    provider = adapter(ClaudeAdapter, transport)

    response = await provider.complete(ProviderRequest(
        "claude", (ChatMessage("user", "query"),),
        tools=({"name": "private_domain_tool", "input_schema": {"type": "object"}},),
        web_search=True,
    ))

    payload = transport.calls[0][2]
    assert payload["tools"] == [{"type": "web_search_20250305", "name": "web_search", "max_uses": 2}]
    assert response.sources == ("https://example.org/a", "http://docs.example.org/b")
    assert response.search_used is True
    assert response.usage.extra_cost == Decimal("0.02")


@pytest.mark.asyncio
async def test_claude_citations_count_as_evidence_but_failed_empty_search_does_not():
    cited = SyntheticTransport({"content": [{"type": "text", "text": "Answer", "citations": [
        {"type": "web_search_result_location", "url": "https://example.org/cited"},
    ]}], "usage": {"server_tool_use": {"web_search_requests": 1}}})
    response = await adapter(ClaudeAdapter, cited).complete(ProviderRequest("m", (), web_search=True))
    assert response.sources == ("https://example.org/cited",)
    assert response.search_used is True
    assert response.usage.extra_cost == Decimal("0.01")

    failed = SyntheticTransport({"content": [{"type": "web_search_tool_result", "content": {
        "type": "web_search_tool_result_error", "error_code": "unavailable"}}],
        "usage": {"server_tool_use": {"web_search_requests": 1}}})
    response = await adapter(ClaudeAdapter, failed).complete(ProviderRequest("m", (), web_search=True))
    assert not response.sources and not response.search_used
    assert response.usage.extra_cost == Decimal("0.01")

    empty = SyntheticTransport({"content": [{"type": "web_search_tool_result", "content": []}],
                                "usage": {"server_tool_use": {"web_search_requests": 1}}})
    response = await adapter(ClaudeAdapter, empty).complete(ProviderRequest("m", (), web_search=True))
    assert not response.sources and not response.search_used
    assert response.usage.extra_cost == Decimal("0.01")


@pytest.mark.asyncio
async def test_openrouter_exa_plugin_extracts_only_annotations_and_accounts_fee():
    transport = SyntheticTransport({"id": "or-1", "choices": [{"message": {
        "content": "A prose URL https://fabricated.invalid",
        "annotations": [
            {"type": "url_citation", "url_citation": {"url": "https://source.example/a"}},
            {"type": "url_citation", "url_citation": {"url": "https://source.example/b"}},
        ],
    }}], "usage": {"prompt_tokens": 4, "completion_tokens": 3}})
    provider = adapter(OpenRouterAdapter, transport)

    response = await provider.complete(ProviderRequest("model", (ChatMessage("user", "query"),), web_search=True))

    assert transport.calls[0][2]["plugins"] == [{"id": "web", "engine": "exa", "max_results": 3}]
    assert response.sources == ("https://source.example/a", "https://source.example/b")
    assert response.search_used is True
    assert response.usage.extra_cost == Decimal("0.007")


@pytest.mark.asyncio
async def test_openrouter_reported_cost_replaces_estimated_plugin_fee():
    body = {"choices": [{"message": {"content": "ok", "annotations": [
        {"type": "url_citation", "url_citation": {"url": "https://source.example"}},
    ]}}], "usage": {"prompt_tokens": 2, "completion_tokens": 2, "cost": 0.123}}
    response = await adapter(OpenRouterAdapter, SyntheticTransport(body)).complete(
        ProviderRequest("model", (), web_search=True))
    assert response.usage.reported_cost == Decimal("0.123")
    assert response.usage.extra_cost == Decimal(0)


@pytest.mark.asyncio
async def test_openrouter_missing_usage_keeps_one_bounded_search_fee_per_call():
    provider = adapter(OpenRouterAdapter, SyntheticTransport({"choices": [{"message": {"content": "ok"}}]}))
    first = await provider.complete(ProviderRequest("m", (), web_search=True))
    second = await provider.complete(ProviderRequest("m", (), web_search=True))
    assert first.usage.extra_cost == Decimal("0.007")
    assert second.usage.extra_cost == Decimal("0.007")
    assert first.usage.reported_cost is None


@pytest.mark.parametrize("url", [
    "javascript:alert(1)", "https://user:pass@example.org/", "http://127.0.0.1/a",
    "http://[::1]/", "http://localhost/", "http://10.0.0.1/",
])
@pytest.mark.asyncio
async def test_openrouter_rejects_unsafe_citation_urls(url):
    body = {"choices": [{"message": {"content": "ok", "annotations": [
        {"type": "url_citation", "url_citation": {"url": url}},
    ]}}]}
    response = await adapter(OpenRouterAdapter, SyntheticTransport(body)).complete(
        ProviderRequest("model", (), web_search=True))
    assert response.sources == ()
    assert response.search_used is False


@pytest.mark.parametrize("url", [
    "https://example.org/a\nb", "https://example.org/a\tb", "https://example.org/a\rb",
    "https://example.org/a b",
    "https://example.org/" + "x" * 2050,
])
@pytest.mark.asyncio
async def test_openrouter_rejects_control_and_oversized_citation_urls(url):
    body = {"choices": [{"message": {"content": "ok", "annotations": [
        {"type": "url_citation", "url_citation": {"url": url}},
    ]}}]}
    response = await adapter(OpenRouterAdapter, SyntheticTransport(body)).complete(
        ProviderRequest("model", (), web_search=True))
    assert response.sources == ()
    assert response.search_used is False


def test_stream_usage_fallback_preserves_provider_cost_fields():
    original = Usage(0, 0, Decimal("0.007"), Decimal("0.012"))
    result = _streamed_usage(ProviderRequest("m", (ChatMessage("user", "hello"),)), original, "reply text")
    assert result.input_tokens > 0 and result.output_tokens > 0
    assert result.extra_cost == Decimal("0.007")
    assert result.reported_cost == Decimal("0.012")


def test_usage_tracker_includes_extra_and_reported_cost_without_double_charge():
    model = ModelSpec(ProviderKind.OPENROUTER, "m", frozenset(), 1000, Decimal("0.01"), Decimal("0.02"))
    tracker = UsageTracker()
    first = tracker.record(uuid4(), ProviderKind.OPENROUTER, model,
                           Usage(1000, 1000, extra_cost=Decimal("0.007")))
    assert first.estimated_cost == Decimal("0.037")
    second = tracker.record(uuid4(), ProviderKind.OPENROUTER, model,
                            Usage(1000, 1000, extra_cost=Decimal("0.007"), reported_cost=Decimal("0.123")))
    assert second.estimated_cost == Decimal("0.123")


@pytest.mark.asyncio
async def test_execution_propagates_web_search_flag_to_adapter():
    class Adapter:
        kind = ProviderKind.CLAUDE
        request = None

        async def complete(self, request):
            self.request = request
            from app.ai.models import ProviderResponse
            return ProviderResponse("ok")

        async def stream(self, request):
            yield "ok"

    model = ModelSpec(ProviderKind.CLAUDE, "m", frozenset({Capability.STREAMING}), 1000,
                      Decimal(0), Decimal(0), privacy_classes=frozenset({PrivacyClass.PERSONAL}))
    provider = Adapter()
    service = AIExecutionService([model], {ProviderKind.CLAUDE: provider})
    await service.complete(uuid4(), RoutingRequest(TaskKind.REASONING),
                           (ChatMessage("user", "query"),), web_search=True)
    assert provider.request.web_search is True


@pytest.mark.parametrize(("kind", "budget", "fee"), [
    (ProviderKind.CLAUDE, Decimal("0.019"), Decimal("0.02")),
    (ProviderKind.OPENROUTER, Decimal("0.006"), Decimal("0.007")),
])
@pytest.mark.asyncio
async def test_execution_rejects_search_budget_below_provider_worst_case(kind, budget, fee):
    class NeverCalled:
        async def complete(self, request):
            raise AssertionError("paid provider call must not happen")

        async def stream(self, request):
            yield ""

    model = ModelSpec(kind, "m", frozenset(), 1000, Decimal(0), Decimal(0),
                      privacy_classes=frozenset({PrivacyClass.PERSONAL}))
    service = AIExecutionService([model], {kind: NeverCalled()})
    with pytest.raises(BudgetExceeded):
        await service.complete(uuid4(), RoutingRequest(TaskKind.REASONING, request_budget=budget),
                               (ChatMessage("user", "query"),), web_search=True)


@pytest.mark.asyncio
async def test_execution_records_search_fee_when_response_has_no_citations():
    class NoCitationAdapter:
        async def complete(self, request):
            from app.ai.models import ProviderResponse
            return ProviderResponse("No grounded response", Usage(2, 3, extra_cost=Decimal("0.007")))

        async def stream(self, request):
            yield ""

    model = ModelSpec(ProviderKind.OPENROUTER, "m", frozenset(), 1000, Decimal(0), Decimal(0),
                      privacy_classes=frozenset({PrivacyClass.PERSONAL}))
    service = AIExecutionService([model], {ProviderKind.OPENROUTER: NoCitationAdapter()})
    result = await service.complete(uuid4(), RoutingRequest(TaskKind.REASONING),
                                    (ChatMessage("user", "query"),), web_search=True)
    assert result.response.search_used is False
    assert result.usage.estimated_cost == Decimal("0.007")
