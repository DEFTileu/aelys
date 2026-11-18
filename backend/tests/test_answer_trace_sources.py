"""Search provenance from documented provider fields to owner run events."""
import json
from decimal import Decimal
from uuid import uuid4

import pytest
from app.ai.execution import AIExecutionService
from app.ai.models import (
    Capability,
    ChatMessage,
    ModelSpec,
    PermissionContext,
    ProviderKind,
    ProviderRequest,
    ProviderResponse,
    RoutingRequest,
    TaskKind,
    ToolCall,
)
from app.ai.policy import ServerPolicyEngine
from app.ai.providers import ClaudeAdapter, HttpResponse, OpenRouterAdapter
from app.ai.secrets import AuthenticatedStreamCipher, SecretRef, SecretStore
from app.ai.tools import ToolRegistry
from app.ai.turn import run_tool_turn
from app.ai.web_search import register_web_search


class ResponseTransport:
    def __init__(self, body):
        self.body = body

    async def post(self, url, *, headers, json):
        return HttpResponse(200, self.body)


def make_adapter(kind, entries):
    # Replace only HTTP; parsing, secrets and egress checks remain real.
    if kind == "claude":
        body = {"content": [
            {"type": "web_search_tool_result", "tool_use_id": "s", "content": entries},
            {"type": "text", "text": "Summary https://fabricated.example/"},
        ]}
        cls = ClaudeAdapter
    else:
        body = {"choices": [{"message": {"role": "assistant", "content": "Summary https://fabricated.example/",
            "annotations": entries}}]}
        cls = OpenRouterAdapter
    store = SecretStore(AuthenticatedStreamCipher(b"trace-test-master-key" * 2))
    ref = SecretRef(kind, "test")
    store.put(ref, "synthetic-credential")
    return cls(ResponseTransport(body), store, ref, "https://provider.invalid")


def entry(kind, url, title=None):
    fields = {"url": url, "title": title}
    if kind == "claude":
        return {"type": "web_search_result", **fields, "encrypted_content": "opaque", "page_age": "2026-11-18"}
    return {"type": "url_citation", "url_citation": {
        **fields, "content": "Do not persist this excerpt", "start_index": 0, "end_index": 7}}


def details(response):
    return [{"url": item.url, "title": item.title} for item in response.source_details]


@pytest.mark.parametrize("kind", ["claude", "openrouter"])
async def test_adapters_preserve_titles_and_url_tuple_compatibility(kind):
    response = await make_adapter(kind, [
        entry(kind, "https://example.org/a", "Page A"),
        entry(kind, "https://example.org/b", "Page B"),
        entry(kind, "https://example.org/c", "Page C"),
    ]).complete(ProviderRequest("test", (), web_search=True))
    assert response.sources == ("https://example.org/a", "https://example.org/b")
    assert response.search_used
    assert details(response) == [
        {"url": "https://example.org/a", "title": "Page A"},
        {"url": "https://example.org/b", "title": "Page B"},
        {"url": "https://example.org/c", "title": "Page C"},
    ]


async def test_claude_citation_titles_fill_missing_result_title_without_duplicate():
    adapter = make_adapter("claude", [entry("claude", "https://example.org/a")])
    adapter._transport.body["content"].append({"type": "text", "text": "Cited answer", "citations": [
        {"type": "web_search_result_location", "url": "https://example.org/a", "title": "Cited A",
         "encrypted_index": "opaque", "cited_text": "Private excerpt"},
        {"type": "web_search_result_location", "url": "https://example.org/b", "title": "Cited B"},
    ]})
    response = await adapter.complete(ProviderRequest("test", (), web_search=True))
    assert details(response) == [
        {"url": "https://example.org/a", "title": "Cited A"},
        {"url": "https://example.org/b", "title": "Cited B"},
    ]


@pytest.mark.parametrize("kind", ["claude", "openrouter"])
async def test_details_are_bounded_deduplicated_and_ignore_untrusted_shapes(kind):
    entries = [None, "bad", {}, {"type": "url_citation", "url_citation": "bad"},
               entry(kind, "https://example.org/0", "  A\n title\t "),
               entry(kind, "https://example.org/0", "Duplicate"),
               entry(kind, "https://example.org/1", "Ж" * 400),
               entry(kind, "https://example.org/2", {"secret": "not a title"})]
    entries += [entry(kind, f"https://example.org/{n}", f"Title {n}") for n in range(3, 12)]
    response = await make_adapter(kind, entries).complete(ProviderRequest("test", (), web_search=True))
    found = details(response)
    assert len(found) == 10
    assert found[:3] == [
        {"url": "https://example.org/0", "title": "A title"},
        {"url": "https://example.org/1", "title": "Ж" * 300},
        {"url": "https://example.org/2", "title": ""},
    ]
    assert found[-1] == {"url": "https://example.org/9", "title": "Title 9"}
    assert response.sources == ("https://example.org/0", "https://example.org/1")


@pytest.mark.parametrize("kind", ["claude", "openrouter"])
async def test_details_apply_existing_url_filter_and_do_not_mine_answer_text(kind):
    unsafe = ["javascript:alert(1)", "http://localhost/", "http://127.0.0.1/", "http://[::1]/",
              "http://10.0.0.1/", "https://user:pass@example.org/", "http://host.internal/",
              "https://example.org/a\nb", "https://example.org/" + "x" * 2050, None]
    response = await make_adapter(kind, [entry(kind, url, "Unsafe") for url in unsafe]).complete(
        ProviderRequest("test", (), web_search=True))
    assert response.sources == ()
    assert details(response) == []
    assert not response.search_used


@pytest.mark.parametrize("kind", ["claude", "openrouter"])
async def test_titles_do_not_expand_legacy_url_byte_budget(kind):
    first = "https://example.org/" + "a" * 1400
    second = "https://example.org/" + "b" * 1400
    response = await make_adapter(kind, [entry(kind, first, "First"), entry(kind, second, "Second")]).complete(
        ProviderRequest("test", (), web_search=True))
    assert response.sources == (first,)
    assert details(response) == [{"url": first, "title": "First"}, {"url": second, "title": "Second"}]


@pytest.mark.parametrize("kind", ["claude", "openrouter"])
async def test_non_search_response_does_not_expose_search_details(kind):
    response = await make_adapter(kind, [entry(kind, "https://example.org/", "Title")]).complete(
        ProviderRequest("test", ()))
    assert response.sources == ()
    assert details(response) == []
    assert not response.search_used


@pytest.mark.parametrize("kind", ["claude", "openrouter", "legacy"])
@pytest.mark.parametrize("title", ["Ordinary headline", "Contact editor@example.org"])
async def test_search_result_event_projects_titles_without_provider_excerpts(kind, title):
    provider = make_adapter(kind, [entry(kind, f"https://example.org/{n}", title) for n in range(12)])
    messages_seen = []

    class Adapter:
        async def complete(self, request):
            if request.web_search:
                if kind == "legacy":
                    return ProviderResponse("Legacy summary", sources=("https://example.org/old",), search_used=True)
                return await provider.complete(request)
            messages_seen.append(request.messages)
            if len(messages_seen) == 1:
                return ProviderResponse("", tool_calls=({"id": "s", "name": "web_search", "input": {"query": "today"}},))
            return ProviderResponse("Answer https://fabricated.example/ https://example.org/0 https://example.org/2")

    registry = ToolRegistry(ServerPolicyEngine())
    register_web_search(registry)
    model = ModelSpec(ProviderKind.CLAUDE, "test", frozenset({Capability.TOOL_CALLING}), 10000, Decimal(0), Decimal(0))
    service = AIExecutionService([model], {ProviderKind.CLAUDE: Adapter()})
    events = []

    async def event(name, payload):
        events.append((name, payload))

    result = await run_tool_turn(service, uuid4(), RoutingRequest(TaskKind.TOOL_ACTION),
        (ChatMessage("user", "Search today"),), registry,
        PermissionContext(actor="owner", scopes=frozenset({"web.search"}), external_scopes=frozenset({"web.search"})),
        parse_call=lambda raw: ToolCall(raw["name"], raw["input"], raw["id"]), on_event=event)
    payload = next(payload for name, payload in events if name == "ai.tool.result")
    expected = ([{"url": "https://example.org/old", "title": ""}] if kind == "legacy" else
                [{"url": f"https://example.org/{n}", "title": title} for n in range(10)])
    assert payload["result"] == {"status": "ok", "sources": expected}
    assert payload["query"] == "today"
    # The execution service has already fenced the untrusted tool data for the adapter.
    assert messages_seen[-1][-1].content.startswith("<untrusted_data source='external'>\n")
    tool_content = messages_seen[-1][-1].content.split("\n", 1)[1].rsplit("\n", 1)[0]
    assert json.loads(tool_content) == {
        "text": "Legacy summary" if kind == "legacy" else "Summary [ссылка скрыта]",
        "sources": ["https://example.org/old"] if kind == "legacy" else
                   ["https://example.org/0", "https://example.org/1"],
        "untrusted": True,
    }
    assert "fabricated.example" not in result.text
    assert "https://example.org/2" not in result.text
    if kind != "legacy":
        assert result.text.endswith("Источники:\nhttps://example.org/0\nhttps://example.org/1")


@pytest.mark.parametrize("kind", ["claude", "openrouter"])
async def test_surrogate_title_is_utf8_serializable(kind):
    response = await make_adapter(kind, [entry(kind, "https://example.org/a", "Bad \ud800 title \udfff")]).complete(
        ProviderRequest("test", (), web_search=True))
    encoded = json.dumps(details(response), ensure_ascii=False).encode("utf-8")
    assert json.loads(encoded) == [{"url": "https://example.org/a", "title": "Bad ? title ?"}]


async def test_legacy_event_sources_are_filtered_deduplicated_and_bounded():
    sources = ("http://localhost/", "https://example.org/" + "x" * 2050,
               "https://example.org/\ud800", "https://user:pass@example.org/", "javascript:alert(1)",
               "https://example.org/a\nb", "https://example.org/0", "https://example.org/0",
               *(f"https://example.org/{n}" for n in range(1, 12)))

    class Adapter:
        async def complete(self, request):
            if request.web_search:
                return ProviderResponse("Summary", sources=sources, search_used=True)
            return ProviderResponse("", tool_calls=({"id": "s", "name": "web_search", "input": {"query": "today"}},))

    registry = ToolRegistry(ServerPolicyEngine())
    register_web_search(registry)
    model = ModelSpec(ProviderKind.CLAUDE, "test", frozenset({Capability.TOOL_CALLING}), 10000, Decimal(0), Decimal(0))
    events = []

    async def event(name, payload):
        # Exercise the same ensure_ascii=False + UTF-8 boundary as the Web SSE emitter.
        events.append((name, json.loads(json.dumps(payload, ensure_ascii=False).encode("utf-8"))))

    await run_tool_turn(AIExecutionService([model], {ProviderKind.CLAUDE: Adapter()}), uuid4(),
        RoutingRequest(TaskKind.TOOL_ACTION), (ChatMessage("user", "Search"),), registry,
        PermissionContext(actor="owner", scopes=frozenset({"web.search"}), external_scopes=frozenset({"web.search"})),
        parse_call=lambda raw: ToolCall(raw["name"], raw["input"], raw["id"]), on_event=event, max_steps=1)
    payload = next(payload for name, payload in events if name == "ai.tool.result")
    assert payload["result"] == {"status": "ok", "sources": [
        {"url": f"https://example.org/{n}", "title": ""} for n in range(10)]}
