from __future__ import annotations

import pytest
from app.automation.hooks import wait_for_automations
from app.core.models import Notification, Task
from sqlalchemy import func, select
from test_automation_api import _owner, _rule

pytest_plugins = ("test_automation_api",)


def _notify_rule(trigger_kind: str, conditions: dict | None = None) -> dict:
    rule = _rule()
    rule["trigger_kind"] = trigger_kind
    rule["conditions"] = conditions or {}
    rule["actions"] = [{"kind": "create_notification", "args": {"title": "Fired"}}]
    return rule


async def _runs(client, headers) -> list[dict]:
    response = await client.get("/api/v1/automations/runs", headers=headers)
    assert response.status_code == 200
    return response.json()


async def _count(factory, model) -> int:
    async with factory() as session:
        return await session.scalar(select(func.count()).select_from(model)) or 0


@pytest.mark.asyncio
async def test_task_created_rule_fires_after_commit(automation_client):
    client, factory = automation_client
    headers = await _owner(client)
    assert (await client.post("/api/v1/automations", json=_notify_rule("task.created"), headers=headers)).status_code == 200

    created = await client.post("/api/v1/tasks", json={"title": "Hello"}, headers=headers)
    assert created.status_code == 200
    await wait_for_automations()

    runs = await _runs(client, headers)
    assert [run["status"] for run in runs] == ["success"]
    assert await _count(factory, Notification) == 1


@pytest.mark.asyncio
async def test_automation_created_task_does_not_reenter_queue(automation_client):
    client, factory = automation_client
    headers = await _owner(client)
    assert (await client.post("/api/v1/automations", json=_rule(), headers=headers)).status_code == 200

    assert (await client.post("/api/v1/tasks", json={"title": "Seed"}, headers=headers)).status_code == 200
    await wait_for_automations()

    assert await _count(factory, Task) == 2
    assert len(await _runs(client, headers)) == 1


@pytest.mark.asyncio
async def test_task_completed_fires_once_per_completion(automation_client):
    client, _ = automation_client
    headers = await _owner(client)
    assert (await client.post("/api/v1/automations", json=_notify_rule("task.completed"), headers=headers)).status_code == 200
    created = await client.post("/api/v1/tasks", json={"title": "Ship", "status": "inbox"}, headers=headers)
    task_id = created.json()["id"]
    await wait_for_automations()
    assert await _runs(client, headers) == []

    done = await client.patch(
        f"/api/v1/tasks/{task_id}",
        json={"title": "Ship", "status": "done", "version": created.json()["version"]},
        headers=headers,
    )
    assert done.status_code == 200
    await wait_for_automations()
    assert len(await _runs(client, headers)) == 1

    again = await client.patch(
        f"/api/v1/tasks/{task_id}",
        json={"title": "Ship it", "status": "done", "version": done.json()["version"]},
        headers=headers,
    )
    assert again.status_code == 200
    await wait_for_automations()
    assert len(await _runs(client, headers)) == 1


@pytest.mark.asyncio
async def test_note_created_fires(automation_client):
    client, factory = automation_client
    headers = await _owner(client)
    assert (await client.post("/api/v1/automations", json=_notify_rule("note.created"), headers=headers)).status_code == 200

    created = await client.post("/api/v1/notes", json={"title": "Idea"}, headers=headers)
    assert created.status_code == 200
    await wait_for_automations()

    assert [run["status"] for run in await _runs(client, headers)] == ["success"]
    assert await _count(factory, Notification) == 1


@pytest.mark.asyncio
async def test_project_condition_filters_events(automation_client):
    client, _ = automation_client
    headers = await _owner(client)
    project_a = (await client.post("/api/v1/projects", json={"name": "A"}, headers=headers)).json()["id"]
    project_b = (await client.post("/api/v1/projects", json={"name": "B"}, headers=headers)).json()["id"]
    rule = _notify_rule("task.created", {"project_id": project_a})
    assert (await client.post("/api/v1/automations", json=rule, headers=headers)).status_code == 200

    assert (await client.post("/api/v1/tasks", json={"title": "B task", "project_id": project_b}, headers=headers)).status_code == 200
    await wait_for_automations()
    assert await _runs(client, headers) == []

    assert (await client.post("/api/v1/tasks", json={"title": "A task", "project_id": project_a}, headers=headers)).status_code == 200
    await wait_for_automations()
    assert [run["status"] for run in await _runs(client, headers)] == ["success"]
