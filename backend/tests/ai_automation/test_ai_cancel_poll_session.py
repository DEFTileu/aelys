from __future__ import annotations

import asyncio
import threading
import time

import httpx
import pytest
from app.ai import http_transport
from app.core import db
from app.core.models import AIRun
from app.main import app
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker

FRAME = b'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n'


@pytest.mark.asyncio
async def test_provider_reply_during_cancellation_poll_keeps_the_run_session_usable(ai_test_engine, monkeypatch):
    session_factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", session_factory)
    polling = threading.Event()

    @event.listens_for(ai_test_engine.sync_engine, "before_cursor_execute")
    def slow_status_poll(conn, cursor, statement, parameters, context, executemany):
        # Runs on the driver thread: the provider replies while this poll is inside the query.
        if "SELECT ai_runs.status" in statement:
            polling.set()
            time.sleep(0.05)

    async def provider(request: httpx.Request) -> httpx.Response:
        polling.clear()
        while not polling.is_set():
            await asyncio.sleep(0.001)
        return httpx.Response(200, content=FRAME, headers={"Content-Type": "text/event-stream"})

    real_client = httpx.AsyncClient
    async with real_client(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        monkeypatch.setattr(http_transport.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(provider), **kwargs))
        bootstrap = await client.post("/api/v1/auth/bootstrap", json={"email": "poll@example.com", "password": "correct horse battery staple"})
        headers = {"Authorization": f"Bearer {bootstrap.json()['access_token']}"}
        created = await client.post("/api/v1/ai/providers", headers=headers, json={"kind": "claude", "model_policy": {"models": [{"name": "fake-model", "capabilities": ["streaming"], "context_tokens": 4096}]}})
        await client.put(f"/api/v1/ai/providers/{created.json()['id']}/secret", headers=headers, json={"api_key": "test-only-provider-key"})
        conversation = await client.post("/api/v1/ai/conversations", headers=headers, json={"tool_scope": {"scopes": []}})
        run = await client.post("/api/v1/ai/runs", headers=headers, json={"conversation_id": conversation.json()["id"], "message": "hi", "routing": {"provider": "claude", "model": "fake-model"}, "idempotency_key": "poll-test"})
        run_id = run.json()["id"]
        async with client.stream("GET", f"/api/v1/ai/runs/{run_id}/events", headers=headers) as response:
            body = (await response.aread()).decode()
    event.remove(ai_test_engine.sync_engine, "before_cursor_execute", slow_status_poll)
    assert "event: ai.text.delta" in body
    assert "event: ai.run.completed" in body
    async with session_factory() as session:
        stored = await session.get(AIRun, run_id)
        assert stored is not None and stored.status == "completed"
