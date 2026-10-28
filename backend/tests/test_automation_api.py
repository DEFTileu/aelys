from __future__ import annotations

import asyncio

import pytest
from app.core import db
from app.core.db import Base
from app.core.models import AutomationExecution, Task
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def automation_client(tmp_path, monkeypatch):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path}/automation.db",
        connect_args={"timeout": 30},
    )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", factory)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client, factory
    await engine.dispose()


async def _owner(client: AsyncClient) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/bootstrap",
        json={
            "email": "automation@example.com",
            "password": "correct horse battery staple",
        },
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _rule(policy_ref: str = "safe") -> dict:
    return {
        "name": "Task automation",
        "trigger_kind": "task.created",
        "conditions": {},
        "actions": [{"kind": "create_task", "args": {"title": "Generated task"}}],
        "policy_ref": policy_ref,
    }


@pytest.mark.asyncio
async def test_rule_action_contract_rejects_unknown_and_coerced_arguments(
    automation_client,
):
    client, _ = automation_client
    headers = await _owner(client)

    unknown_action = _rule()
    unknown_action["actions"] = [
        {"kind": "create_task", "args": {"title": "ok", "extra": True}}
    ]
    response = await client.post(
        "/api/v1/automations", json=unknown_action, headers=headers
    )
    assert response.status_code == 422

    wrong_type = _rule()
    wrong_type["actions"] = [{"kind": "create_task", "args": {"title": 123}}]
    response = await client.post(
        "/api/v1/automations", json=wrong_type, headers=headers
    )
    assert response.status_code == 422

    unregistered = _rule()
    unregistered["actions"] = [{"kind": "shell", "args": {"command": "touch outside"}}]
    response = await client.post(
        "/api/v1/automations", json=unregistered, headers=headers
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_dispatch_fails_closed_for_unknown_policy_and_project_scope(
    automation_client,
):
    client, factory = automation_client
    headers = await _owner(client)

    unknown_policy_rule = _rule("operator-supplied")
    unknown_policy_rule["trigger_kind"] = "unknown.policy"
    unknown_policy_response = await client.post(
        "/api/v1/automations", json=unknown_policy_rule, headers=headers
    )
    assert unknown_policy_response.status_code == 200
    response = await client.post(
        "/api/v1/automations/dispatch",
        json={
            "event_id": "unknown-policy",
            "event_kind": "unknown.policy",
            "payload": {},
        },
        headers=headers,
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "POLICY_DENIED"

    scoped_rule = _rule()
    scoped_rule["actions"] = [
        {
            "kind": "create_task",
            "args": {"title": "outside", "project_id": "missing-project"},
        }
    ]
    created = await client.post(
        "/api/v1/automations", json=scoped_rule, headers=headers
    )
    assert created.status_code == 200
    response = await client.post(
        "/api/v1/automations/dispatch",
        json={
            "event_id": "missing-project",
            "event_kind": "task.created",
            "payload": {},
        },
        headers=headers,
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "NOT_FOUND"

    async with factory() as session:  # type: AsyncSession
        assert await session.scalar(select(func.count()).select_from(Task)) == 0
        assert (
            await session.scalar(select(func.count()).select_from(AutomationExecution))
            == 0
        )


@pytest.mark.asyncio
async def test_concurrent_dispatch_claims_one_execution_and_one_task(automation_client):
    client, factory = automation_client
    headers = await _owner(client)
    created = await client.post("/api/v1/automations", json=_rule(), headers=headers)
    assert created.status_code == 200

    async def dispatch_once():
        return await client.post(
            "/api/v1/automations/dispatch",
            json={
                "event_id": "concurrent-event",
                "event_kind": "task.created",
                "payload": {},
            },
            headers=headers,
        )

    responses = await asyncio.gather(dispatch_once(), dispatch_once())
    assert [response.status_code for response in responses] == [200, 200]
    assert sorted(
        response.json()["results"][0]["status"] for response in responses
    ) == [
        "completed",
        "duplicate",
    ]

    async with factory() as session:  # type: AsyncSession
        assert await session.scalar(select(func.count()).select_from(Task)) == 1
        assert (
            await session.scalar(select(func.count()).select_from(AutomationExecution))
            == 1
        )
