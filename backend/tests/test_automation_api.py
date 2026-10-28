from __future__ import annotations

import asyncio

import pytest
from app.core import db
from app.core.db import Base
from app.core.models import ActivityEvent, AutomationExecution, Notification, Task
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
        executions = list((await session.scalars(select(AutomationExecution))).all())
        assert len(executions) == 2
        assert {item.run_status for item in executions} == {"failed"}
        assert {item.error_code for item in executions} == {
            "POLICY_DENIED",
            "NOT_FOUND",
        }


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
        assert await session.scalar(select(func.count()).select_from(ActivityEvent)) == 1
        assert (
            await session.scalar(select(func.count()).select_from(AutomationExecution))
            == 1
        )


@pytest.mark.asyncio
async def test_rate_limit_is_owner_scoped_and_persisted(automation_client):
    client, factory = automation_client
    headers = await _owner(client)
    rule = _rule()
    rule["rate_limit"] = {"max_executions": 1, "window_seconds": 3600}
    created = await client.post("/api/v1/automations", json=rule, headers=headers)
    assert created.status_code == 200
    rule_id = created.json()["id"]

    first = await client.post(
        "/api/v1/automations/dispatch",
        json={"event_id": "rate-one", "event_kind": "task.created", "payload": {}},
        headers=headers,
    )
    second = await client.post(
        "/api/v1/automations/dispatch",
        json={"event_id": "rate-two", "event_kind": "task.created", "payload": {}},
        headers=headers,
    )
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["results"] == [
        {"rule_id": rule_id, "status": "rate_limited"}
    ]

    async with factory() as session:  # type: AsyncSession
        executions = list(
            (
                await session.scalars(
                    select(AutomationExecution).where(
                        AutomationExecution.rule_id == rule_id
                    )
                )
            ).all()
        )
        assert {item.run_status for item in executions} == {
            "completed",
            "rate_limited",
        }
        assert await session.scalar(select(func.count()).select_from(Task)) == 1


@pytest.mark.asyncio
async def test_failed_execution_is_audited_retryable_and_rolls_back_partial_actions(
    automation_client,
):
    client, factory = automation_client
    headers = await _owner(client)
    rule = _rule()
    rule["actions"] = [
        {"kind": "create_notification", "args": {"title": "partial"}},
        {
            "kind": "create_task",
            "args": {"title": "blocked", "project_id": "missing-project"},
        },
    ]
    created = await client.post("/api/v1/automations", json=rule, headers=headers)
    assert created.status_code == 200
    rule_id = created.json()["id"]
    event = {
        "event_id": "retryable-failure",
        "event_kind": "task.created",
        "payload": {},
    }

    failed = await client.post(
        "/api/v1/automations/dispatch", json=event, headers=headers
    )
    assert failed.status_code == 404

    async with factory() as session:  # type: AsyncSession
        execution = await session.scalar(
            select(AutomationExecution).where(
                AutomationExecution.rule_id == rule_id,
                AutomationExecution.event_id == event["event_id"],
            )
        )
        assert execution is not None
        assert execution.run_status == "failed"
        assert execution.error_code == "NOT_FOUND"
        assert execution.attempt == 1
        assert await session.scalar(select(func.count()).select_from(Task)) == 0
        assert (
            await session.scalar(select(func.count()).select_from(Notification)) == 0
        )

    patched = await client.patch(
        f"/api/v1/automations/{rule_id}",
        json={
            "actions": [
                {"kind": "create_task", "args": {"title": "retry succeeds"}}
            ]
        },
        headers=headers,
    )
    assert patched.status_code == 200
    retried = await client.post(
        "/api/v1/automations/dispatch", json=event, headers=headers
    )
    assert retried.status_code == 200
    assert retried.json()["results"] == [
        {"rule_id": rule_id, "status": "completed"}
    ]

    async with factory() as session:  # type: AsyncSession
        execution = await session.scalar(
            select(AutomationExecution).where(
                AutomationExecution.rule_id == rule_id,
                AutomationExecution.event_id == event["event_id"],
            )
        )
        assert execution is not None
        assert execution.run_status == "completed"
        assert execution.attempt == 2
        assert await session.scalar(select(func.count()).select_from(Task)) == 1
        assert (
            await session.scalar(select(func.count()).select_from(Notification)) == 0
        )
