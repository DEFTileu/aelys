"""SSE delivery must observe committed run state from a separate connection."""

import json

import pytest
from app.ai import api as ai_api
from app.core import db
from app.core.models import AIRun, AIRunEvent
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker


@pytest.mark.asyncio
@pytest.mark.parametrize("result", ["completed", "failed"])
async def test_terminal_sse_is_committed_with_run_state_before_delivery(
    ai_test_engine, monkeypatch, result
):
    engine = ai_test_engine
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", factory)

    class Transport:
        async def stream(self, *_args, **_kwargs):
            if result == "failed":
                raise RuntimeError("synthetic provider failure")
            yield {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "ok"},
            }

    monkeypatch.setattr(ai_api, "HttpxTransport", lambda **_kwargs: Transport())
    observed = []

    async def observe(scope, receive, send):
        pending = b""

        async def capture(message):
            nonlocal pending
            if message["type"] == "http.response.body" and scope["path"].endswith(
                "/events"
            ):
                pending += message.get("body", b"")
                while b"\n\n" in pending:
                    block, pending = pending.split(b"\n\n", 1)
                    lines = block.decode().splitlines()
                    event = next(
                        line[7:] for line in lines if line.startswith("event: ")
                    )
                    if event in {"ai.run.completed", "ai.run.failed"}:
                        payload = json.loads(
                            next(
                                line[6:] for line in lines if line.startswith("data: ")
                            )
                        )
                        event_id = next(
                            line[4:] for line in lines if line.startswith("id: ")
                        )
                        async with factory() as session:
                            run = await session.get(AIRun, payload["run_id"])
                            record = (
                                await session.execute(
                                    select(AIRunEvent).where(
                                        AIRunEvent.event_id == event_id
                                    )
                                )
                            ).scalar_one_or_none()
                            observed.append((event, run.status, record is not None))
            await send(message)

        await app(scope, receive, capture)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=observe), base_url="http://test"
        ) as client:
            owner = await client.post(
                "/api/v1/auth/bootstrap",
                json={
                    "email": "event-commit@example.test",
                    "password": "correct horse battery staple",
                },
            )
            headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
            provider = await client.post(
                "/api/v1/ai/providers",
                headers=headers,
                json={"kind": "claude", "model_policy": {"default_model": "synthetic"}},
            )
            await client.put(
                f"/api/v1/ai/providers/{provider.json()['id']}/secret",
                headers=headers,
                json={"api_key": "test-only-provider-key"},
            )
            conversation = await client.post(
                "/api/v1/ai/conversations", headers=headers, json={}
            )
            run = await client.post(
                "/api/v1/ai/runs",
                headers=headers,
                json={
                    "conversation_id": conversation.json()["id"],
                    "message": "synthetic",
                    "routing": {},
                    "idempotency_key": "event-commit",
                },
            )
            response = await client.get(
                f"/api/v1/ai/runs/{run.json()['id']}/events", headers=headers
            )
            assert response.status_code == 200
            assert observed == [(f"ai.run.{result}", result, True)]
    finally:
        await engine.dispose()
