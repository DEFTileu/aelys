from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core import db
from app.core.db import Base
from app.core.models import Task
from app.main import app
from app.ai import api as ai_api
from app.ai.providers import HttpResponse


class CountingTransport:
    def __init__(self, **_kwargs):
        self.calls = 0

    async def post(self, url, *, headers, json):
        raise AssertionError(f"unexpected completion request: {url}")

    async def stream(self, url, *, headers, json):
        self.calls += 1
        yield {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}}


class ToolTransport(CountingTransport):
    async def post(self, url, *, headers, json):
        self.calls += 1
        tool_call = {"type": "tool_use", "id": "call-1", "name": "create_task", "input": {"title": "Created by AI"}}
        return HttpResponse(200, {"id": "tool-response", "content": [tool_call, tool_call], "usage": {"input_tokens": 4, "output_tokens": 2}})


class FailingStreamTransport(CountingTransport):
    async def stream(self, url, *, headers, json):
        self.calls += 1
        raise RuntimeError("provider unavailable")
        yield {}


@pytest.mark.asyncio
async def test_ai_routes_bind_owner_project_idempotency_and_provider_endpoint(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/ai-security.db")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", factory)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            bootstrap = await client.post(
                "/api/v1/auth/bootstrap",
                json={"email": "ai-security@example.com", "password": "correct horse battery staple"},
            )
            assert bootstrap.status_code == 200
            headers = {"Authorization": f"Bearer {bootstrap.json()['access_token']}"}

            for base_url in ("http://127.0.0.1:8080", "https://evil.example"):
                response = await client.post(
                    "/api/v1/ai/providers",
                    headers=headers,
                    json={"kind": "claude", "base_url": base_url},
                )
                assert response.status_code == 422
                assert response.json()["detail"]["code"] == "INVALID_PROVIDER_ENDPOINT"

            project = await client.post("/api/v1/projects", headers=headers, json={"name": "Owned"})
            assert project.status_code == 200
            conversation = await client.post(
                "/api/v1/ai/conversations",
                headers=headers,
                json={"project_id": "foreign-project"},
            )
            assert conversation.status_code == 404

            conversation = await client.post("/api/v1/ai/conversations", headers=headers, json={})
            assert conversation.status_code == 200
            payload = {
                "conversation_id": conversation.json()["id"],
                "message": "first prompt",
                "routing": {},
                "tool_scope": {},
                "idempotency_key": "same-ai-request",
            }
            first = await client.post("/api/v1/ai/runs", headers=headers, json=payload)
            assert first.status_code == 200
            changed = {**payload, "message": "different prompt"}
            conflict = await client.post("/api/v1/ai/runs", headers=headers, json=changed)
            assert conflict.status_code == 409
            assert conflict.json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
            scoped_conversation = await client.post(
                "/api/v1/ai/conversations",
                headers=headers,
                json={"tool_scope": {"scopes": ["tasks.write"]}},
            )
            denied = await client.post(
                "/api/v1/ai/runs",
                headers=headers,
                json={
                    "conversation_id": scoped_conversation.json()["id"],
                    "message": "escalate",
                    "tool_scope": {"scopes": ["notes.write"]},
                    "idempotency_key": "scope-escalation",
                },
            )
            assert denied.status_code == 403
            assert denied.json()["detail"]["code"] == "POLICY_DENIED"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_repeated_ai_sse_reads_do_not_reexecute_provider(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/ai-sse.db")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", factory)
    transport = CountingTransport()
    monkeypatch.setattr(ai_api, "HttpxTransport", lambda **kwargs: transport)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            bootstrap = await client.post(
                "/api/v1/auth/bootstrap",
                json={"email": "ai-sse@example.com", "password": "correct horse battery staple"},
            )
            headers = {"Authorization": f"Bearer {bootstrap.json()['access_token']}"}
            provider = await client.post(
                "/api/v1/ai/providers",
                headers=headers,
                json={
                    "kind": "claude",
                    "model_policy": {"models": [{"name": "fake", "capabilities": ["streaming"], "context_tokens": 4096}]},
                },
            )
            await client.put(f"/api/v1/ai/providers/{provider.json()['id']}/secret", headers=headers, json={"api_key": "test-only-provider-key"})
            conversation = await client.post("/api/v1/ai/conversations", headers=headers, json={})
            run = await client.post(
                "/api/v1/ai/runs",
                headers=headers,
                json={"conversation_id": conversation.json()["id"], "message": "once", "routing": {"provider": "claude", "model": "fake"}, "idempotency_key": "sse-once"},
            )
            run_id = run.json()["id"]
            async with client.stream("GET", f"/api/v1/ai/runs/{run_id}/events", headers=headers) as response:
                first_body = (await response.aread()).decode()
            async with client.stream("GET", f"/api/v1/ai/runs/{run_id}/events", headers=headers) as response:
                second_body = (await response.aread()).decode()
            assert "ai.run.completed" in first_body
            assert "replayed" in second_body
            assert transport.calls == 1
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_mounted_ai_tool_call_is_validated_authorized_and_executed_once(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/ai-tool.db")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", factory)
    transport = ToolTransport()
    monkeypatch.setattr(ai_api, "HttpxTransport", lambda **kwargs: transport)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            bootstrap = await client.post(
                "/api/v1/auth/bootstrap",
                json={"email": "ai-tool@example.com", "password": "correct horse battery staple"},
            )
            headers = {"Authorization": f"Bearer {bootstrap.json()['access_token']}"}
            provider = await client.post(
                "/api/v1/ai/providers",
                headers=headers,
                json={
                    "kind": "claude",
                    "model_policy": {"models": [{"name": "tool-model", "capabilities": ["tool_calling"], "context_tokens": 4096}]},
                },
            )
            await client.put(f"/api/v1/ai/providers/{provider.json()['id']}/secret", headers=headers, json={"api_key": "test-only-provider-key"})
            conversation = await client.post("/api/v1/ai/conversations", headers=headers, json={"tool_scope": {"scopes": ["tasks.write"]}})
            run = await client.post(
                "/api/v1/ai/runs",
                headers=headers,
                json={"conversation_id": conversation.json()["id"], "message": "make a task", "routing": {"provider": "claude", "model": "tool-model"}, "idempotency_key": "tool-once"},
            )
            async with client.stream("GET", f"/api/v1/ai/runs/{run.json()['id']}/events", headers=headers) as response:
                body = (await response.aread()).decode()
            assert response.status_code == 200
            assert "ai.tool.requested" in body and "ai.tool.result" in body and "ai.run.completed" in body
            assert transport.calls == 1
            async with factory() as session:
                tasks = (await session.execute(select(Task))).scalars().all()
                assert len(tasks) == 1 and tasks[0].title == "Created by AI"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_provider_failure_is_terminal_failed_not_completed(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/ai-failure.db")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", factory)
    transport = FailingStreamTransport()
    monkeypatch.setattr(ai_api, "HttpxTransport", lambda **kwargs: transport)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            bootstrap = await client.post("/api/v1/auth/bootstrap", json={"email": "ai-failure@example.com", "password": "correct horse battery staple"})
            headers = {"Authorization": f"Bearer {bootstrap.json()['access_token']}"}
            provider = await client.post("/api/v1/ai/providers", headers=headers, json={"kind": "claude", "model_policy": {"models": [{"name": "failure-model", "capabilities": ["streaming"], "context_tokens": 4096}]}})
            await client.put(f"/api/v1/ai/providers/{provider.json()['id']}/secret", headers=headers, json={"api_key": "test-only-provider-key"})
            conversation = await client.post("/api/v1/ai/conversations", headers=headers, json={})
            run = await client.post("/api/v1/ai/runs", headers=headers, json={"conversation_id": conversation.json()["id"], "message": "fail", "routing": {"provider": "claude", "model": "failure-model"}, "idempotency_key": "failure-once"})
            async with client.stream("GET", f"/api/v1/ai/runs/{run.json()['id']}/events", headers=headers) as response:
                body = (await response.aread()).decode()
            assert "ai.run.failed" in body and "ai.run.completed" not in body
            terminal = await client.get(f"/api/v1/ai/runs/{run.json()['id']}", headers=headers)
            assert terminal.json()["status"] == "failed"
    finally:
        await engine.dispose()
