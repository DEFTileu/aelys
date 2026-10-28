from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core import db
from app.core.db import Base
from app.main import app
from app.ai import api as ai_api


class CountingTransport:
    def __init__(self, **_kwargs):
        self.calls = 0

    async def post(self, url, *, headers, json):
        raise AssertionError(f"unexpected completion request: {url}")

    async def stream(self, url, *, headers, json):
        self.calls += 1
        yield {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}}


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
