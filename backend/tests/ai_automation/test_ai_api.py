from __future__ import annotations

import asyncio

import pytest
from app.ai import api as ai_api
from app.ai.errors import RunCancelled
from app.core import db
from app.core.models import AIRun
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker


class BlockingTransport:
    def __init__(
        self,
        *,
        cancel_event: asyncio.Event | None = None,
        tool_mode: bool = False,
        cancel_check=None,
    ):
        self.cancel_event = cancel_event
        self.tool_mode = tool_mode
        self.cancel_check = cancel_check
        self.started = asyncio.Event()
        self.cancel_seen = asyncio.Event()

    async def post(self, url, *, headers, json):
        assert self.tool_mode, "streaming must not call a completion endpoint"
        self.started.set()
        assert self.cancel_event is not None
        await self.wait_for_cancellation()
        self.cancel_seen.set()
        raise RunCancelled("run cancelled")

    async def stream(self, url, *, headers, json):
        self.started.set()
        assert self.cancel_event is not None
        await self.wait_for_cancellation()
        self.cancel_seen.set()
        if False:
            yield {}

    async def wait_for_cancellation(self):
        assert self.cancel_event is not None
        while not self.cancel_event.is_set():
            if self.cancel_check and await self.cancel_check():
                self.cancel_event.set()
                return
            await asyncio.sleep(0.01)


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_mode", [False, True])
async def test_cancel_endpoint_stops_active_provider_stream_and_keeps_cancelled_state(
    ai_test_engine, monkeypatch, tool_mode
):
    engine = ai_test_engine
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", session_factory)

    transport_holder: dict[str, BlockingTransport] = {}

    def transport_factory(*, cancel_event=None, cancel_check=None):
        transport = BlockingTransport(
            cancel_event=cancel_event, tool_mode=tool_mode, cancel_check=cancel_check
        )
        transport_holder["transport"] = transport
        return transport

    monkeypatch.setattr(ai_api, "HttpxTransport", transport_factory)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            bootstrap = await client.post(
                "/api/v1/auth/bootstrap",
                json={
                    "email": "ai-cancel@example.com",
                    "password": "correct horse battery staple",
                },
            )
            assert bootstrap.status_code == 200
            headers = {"Authorization": f"Bearer {bootstrap.json()['access_token']}"}

            provider = await client.post(
                "/api/v1/ai/providers",
                headers=headers,
                json={
                    "kind": "claude",
                    "model_policy": {
                        "models": [
                            {
                                "name": "fake-stream-model",
                                "capabilities": ["streaming", "tool_calling"],
                                "context_tokens": 4096,
                                "input_cost_per_1k": "0",
                                "output_cost_per_1k": "0",
                            }
                        ]
                    },
                },
            )
            assert provider.status_code == 200
            secret = await client.put(
                f"/api/v1/ai/providers/{provider.json()['id']}/secret",
                headers=headers,
                json={"api_key": "test-only-provider-key"},
            )
            assert secret.status_code == 200

            conversation = await client.post(
                "/api/v1/ai/conversations",
                headers=headers,
                json={"tool_scope": {"scopes": ["tasks.write"]}} if tool_mode else {},
            )
            assert conversation.status_code == 200
            run = await client.post(
                "/api/v1/ai/runs",
                headers=headers,
                json={
                    "conversation_id": conversation.json()["id"],
                    "message": "wait for cancellation",
                    "routing": {"provider": "claude", "model": "fake-stream-model"},
                    "idempotency_key": "ai-cancel-test",
                },
            )
            assert run.status_code == 200
            run_id = run.json()["id"]

            async def read_events():
                async with client.stream(
                    "GET", f"/api/v1/ai/runs/{run_id}/events", headers=headers
                ) as response:
                    assert response.status_code == 200
                    return await response.aread()

            stream_task = asyncio.create_task(read_events())
            transport = await asyncio.wait_for(
                _transport_ready(transport_holder), timeout=1
            )
            await asyncio.wait_for(transport.started.wait(), timeout=1)
            before_cancel = await client.get(
                f"/api/v1/ai/runs/{run_id}", headers=headers
            )
            assert before_cancel.json()["status"] == "running"

            cancellation = await client.post(
                f"/api/v1/ai/runs/{run_id}/cancel", headers=headers
            )
            assert cancellation.status_code == 200
            assert cancellation.json()["status"] == "cancelled"

            await asyncio.wait_for(transport.cancel_seen.wait(), timeout=1)
            stream_body = (await asyncio.wait_for(stream_task, timeout=1)).decode()
            assert "event: ai.run.cancelled" in stream_body
            assert "event: ai.run.completed" not in stream_body
            assert "event: ai.run.failed" not in stream_body

            terminal = await client.get(f"/api/v1/ai/runs/{run_id}", headers=headers)
            assert terminal.status_code == 200
            assert terminal.json()["status"] == "cancelled"

            queued = await client.post(
                "/api/v1/ai/runs",
                headers=headers,
                json={
                    "conversation_id": conversation.json()["id"],
                    "message": "cancel before starting",
                    "routing": {"provider": "claude", "model": "fake-stream-model"},
                    "idempotency_key": "ai-cancel-before-start",
                },
            )
            queued_id = queued.json()["id"]
            cancelled = await client.post(
                f"/api/v1/ai/runs/{queued_id}/cancel", headers=headers
            )
            assert (
                cancelled.status_code == 200
                and cancelled.json()["status"] == "cancelled"
            )
            async with client.stream(
                "GET", f"/api/v1/ai/runs/{queued_id}/events", headers=headers
            ) as response:
                assert response.status_code == 200
                assert "event: ai.run.cancelled" in (await response.aread()).decode()

            revoked_run = await client.post(
                "/api/v1/ai/runs",
                headers=headers,
                json={
                    "conversation_id": conversation.json()["id"],
                    "message": "cancel when the session is revoked",
                    "routing": {"provider": "claude", "model": "fake-stream-model"},
                    "idempotency_key": "ai-session-revocation-test",
                },
            )
            revoked_id = revoked_run.json()["id"]
            transport_holder.clear()

            async def read_revoked_events():
                async with client.stream(
                    "GET", f"/api/v1/ai/runs/{revoked_id}/events", headers=headers
                ) as response:
                    assert response.status_code == 200
                    return await response.aread()

            revoked_stream = asyncio.create_task(read_revoked_events())
            revoked_transport = await asyncio.wait_for(
                _transport_ready(transport_holder), timeout=1
            )
            await asyncio.wait_for(revoked_transport.started.wait(), timeout=1)
            logout = await client.post("/api/v1/auth/logout", headers=headers)
            assert logout.status_code == 200
            await asyncio.wait_for(revoked_transport.cancel_seen.wait(), timeout=1)
            revoked_body = (await asyncio.wait_for(revoked_stream, timeout=1)).decode()
            assert "event: ai.run.cancelled" in revoked_body
            assert (
                await client.get(f"/api/v1/ai/runs/{revoked_id}", headers=headers)
            ).status_code == 401

            async with session_factory() as session:
                persisted = await session.get(AIRun, revoked_id)
                assert persisted is not None and persisted.status == "cancelled"
    finally:
        await engine.dispose()


async def _transport_ready(holder: dict[str, BlockingTransport]) -> BlockingTransport:
    while "transport" not in holder:
        await asyncio.sleep(0)
    return holder["transport"]
