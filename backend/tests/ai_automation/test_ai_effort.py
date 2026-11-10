from __future__ import annotations

import pytest
from app.ai.models import ChatMessage, ProviderRequest, ToolCall
from app.ai.providers import ClaudeAdapter, OpenRouterAdapter
from app.core import db
from app.core.models import Base
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def _request(effort=None):
    return ProviderRequest("m", (ChatMessage("user", "hi"),), max_tokens=1000, effort=effort)


def _claude(effort=None):
    return ClaudeAdapter._payload(object.__new__(ClaudeAdapter), _request(effort))


def _router(effort=None):
    return OpenRouterAdapter._payload(object.__new__(OpenRouterAdapter), _request(effort))


@pytest.mark.parametrize("effort", ["low", "medium", "high"])
def test_claude_payload_uses_adaptive_thinking_with_effort(effort):
    payload = _claude(effort)
    assert payload["thinking"] == {"type": "adaptive"} and payload["output_config"] == {"effort": effort}
    assert payload["max_tokens"] == 16000 and "budget_tokens" not in str(payload)


def test_claude_payload_caches_the_prompt_prefix():
    assert _claude()["cache_control"] == {"type": "ephemeral"} and _claude("low")["cache_control"] == {"type": "ephemeral"}


def test_claude_payload_never_sends_sampling_params():
    assert "temperature" not in _claude() and "temperature" not in _claude("high")


def test_off_sends_no_reasoning_fields():
    assert "thinking" not in _claude() and "reasoning" not in _router()


def _history():
    calls = (ToolCall("create_task", {"title": "Quiz"}, "c1"), ToolCall("list_tasks", {}, "c2"))
    return (ChatMessage("system", "rules"), ChatMessage("user", "add a quiz"), ChatMessage("assistant", "", tool_calls=calls),
            ChatMessage("tool", '{"proposed": true}', tool_call_id="c1"), ChatMessage("tool", '{"items": []}', tool_call_id="c2"))


def test_claude_replays_tool_calls_and_groups_their_results():
    payload = ClaudeAdapter._payload(object.__new__(ClaudeAdapter), ProviderRequest("m", _history(), max_tokens=10))
    assert payload["system"] == "rules"
    assert payload["messages"][1] == {"role": "assistant", "content": [{"type": "tool_use", "id": "c1", "name": "create_task", "input": {"title": "Quiz"}},
                                                                       {"type": "tool_use", "id": "c2", "name": "list_tasks", "input": {}}]}
    assert payload["messages"][2] == {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c1", "content": '{"proposed": true}'},
                                                                  {"type": "tool_result", "tool_use_id": "c2", "content": '{"items": []}'}]}


def test_openrouter_replays_tool_calls_as_function_calls():
    messages = OpenRouterAdapter._payload(object.__new__(OpenRouterAdapter), ProviderRequest("m", _history(), max_tokens=10))["messages"]
    assert messages[2]["tool_calls"][0] == {"id": "c1", "type": "function", "function": {"name": "create_task", "arguments": '{"title": "Quiz"}'}}
    assert messages[3:] == [{"role": "tool", "tool_call_id": "c1", "content": '{"proposed": true}'}, {"role": "tool", "tool_call_id": "c2", "content": '{"items": []}'}]


def test_openrouter_payload_sets_reasoning_effort():
    assert _router("medium")["reasoning"] == {"effort": "medium"}


@pytest.mark.asyncio
async def test_create_run_validates_effort(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/effort.db")
    monkeypatch.setattr(db, "SessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            boot = await client.post("/api/v1/auth/bootstrap", json={"email": "effort@example.com", "password": "correct horse battery staple"})
            headers = {"Authorization": f"Bearer {boot.json()['access_token']}"}
            convo = (await client.post("/api/v1/ai/conversations", headers=headers, json={"tool_scope": {"scopes": []}})).json()

            async def run(effort, key):
                routing = {} if effort is None else {"effort": effort}
                return await client.post("/api/v1/ai/runs", headers=headers, json={"conversation_id": convo["id"], "message": "x", "routing": routing, "idempotency_key": key})

            bad = await run("extreme", "k1")
            assert bad.status_code == 400 and bad.json()["detail"]["code"] == "INVALID_EFFORT"
            for i, effort in enumerate(["low", "medium", "high", "off", None]):
                assert (await run(effort, f"ok{i}")).status_code == 200
    finally:
        await engine.dispose()
