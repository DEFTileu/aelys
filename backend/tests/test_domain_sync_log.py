"""Domain mutations must share the device sync change-log transaction."""

from datetime import datetime
from uuid import uuid4

import httpx
import pytest
from app.ai import api as ai_api
from app.ai.crypto import encrypt_secret
from app.ai.providers import HttpResponse
from app.core import db
from app.core.db import Base
from app.core.models import (
    CalendarEvent,
    Note,
    NoteRevision,
    Project,
    SyncChange,
    SyncRecord,
    Task,
    User,
)
from app.domains import capture
from app.integrations import telegram_service
from app.integrations.telegram_models import TelegramIntegration, TelegramUpdateReceipt
from app.main import app
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def sync_domain_setup(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/domain-sync.db")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr(db, "SessionLocal", sessions)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/v1/auth/bootstrap",
                json={"email": "sync-owner@example.test", "password": "correct horse battery staple"},
            )
            assert response.status_code == 200, response.text
            client.headers["Authorization"] = "Bearer " + response.json()["access_token"]
            enrolled = await client.post(
                "/api/v1/devices/enroll",
                json={"platform": "web", "display_name": "Domain sync contracts"},
            )
            assert enrolled.status_code == 200, enrolled.text
            device = enrolled.json()
            client.headers["Authorization"] = "Bearer " + device["access_token"]
            yield client, sessions, device["device_id"]
    finally:
        await engine.dispose()


@pytest.mark.parametrize("endpoint,key", [("pull", "changes"), ("bootstrap", "resources")])
async def test_rest_task_is_visible_to_sync(sync_domain_setup, endpoint, key):
    client, _, _ = sync_domain_setup
    created = await client.post("/api/v1/tasks", json={"title": "REST sync regression"})
    assert created.status_code == 200, created.text
    task = created.json()
    response = await client.get(f"/api/v1/sync/{endpoint}")
    assert response.status_code == 200, response.text
    matches = [
        change for change in response.json()[key]
        if change["resource_kind"] == "task" and change["resource_id"] == task["id"]
    ]
    assert matches, f"REST task {task['id']} is absent from sync/{endpoint}: {response.json()}"
    assert matches[-1]["version"] == task["version"]
    assert matches[-1]["payload"]["title"] == task["title"]


async def assert_sync_state(client, kind, item_id, version, operation, fields, cursor="0"):
    pulled = await client.get("/api/v1/sync/pull", params={"cursor": cursor})
    assert pulled.status_code == 200, pulled.text
    changes = [row for row in pulled.json()["changes"] if row["resource_kind"] == kind and row["resource_id"] == item_id]
    assert len(changes) == 1, pulled.json()
    change = changes[0]
    assert (change["version"], change["operation"]) == (version, operation)
    for field, value in fields.items():
        assert change["payload"][field] == value
    snapshot = await client.get("/api/v1/sync/bootstrap", params={"scope": kind})
    assert snapshot.status_code == 200, snapshot.text
    resources = [row for row in snapshot.json()["resources"] if row["resource_id"] == item_id]
    assert len(resources) == 1, snapshot.json()
    resource = resources[0]
    assert resource["version"] == version
    assert resource["deleted"] is (operation == "delete")
    assert resource["payload"] == change["payload"]
    return pulled.json()["next_cursor"]


@pytest.mark.parametrize(
    "kind,path,model,body,label",
    [
        ("task", "/tasks", Task, {"title": "Original task"}, "title"),
        ("note", "/notes", Note, {"title": "Original note", "markdown_body": "Body"}, "title"),
        ("event", "/calendar/events", CalendarEvent, {
            "title": "Original event", "starts_at": "2026-11-05T12:00:00Z",
            "ends_at": "2026-11-05T13:00:00Z", "timezone": "UTC",
        }, "title"),
        ("project", "/projects", Project, {"name": "Original project"}, "name"),
    ],
)
async def test_domain_crud_reaches_pull_bootstrap_and_matches_owned_version(
    sync_domain_setup, kind, path, model, body, label
):
    client, sessions, _ = sync_domain_setup
    response = await client.post("/api/v1" + path, json=body)
    assert response.status_code == 200, response.text
    created = response.json()
    item_id = created["id"]
    assert created["version"] == 1
    cursor = await assert_sync_state(client, kind, item_id, 1, "create", {label: body[label]})

    patch = {**body, label: "Server edited", "version": created["version"]}
    # Notes carry their optimistic version in the query, not the body schema.
    if kind == "note":
        patch.pop("version")
    response = await client.patch(
        "/api/v1" + path + "/" + item_id, json=patch, params={"version": created["version"]}
    )
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["version"] == 2
    cursor = await assert_sync_state(client, kind, item_id, 2, "update", {label: "Server edited"}, cursor)

    response = await client.delete(
        "/api/v1" + path + "/" + item_id, params={"version": updated["version"]}
    )
    assert response.status_code == 200, response.text
    await assert_sync_state(client, kind, item_id, 3, "delete", {}, cursor)
    async with sessions() as session:
        item = await session.get(model, item_id)
        assert item.version == 3 and item.deleted_at is not None
        changes = (await session.execute(select(SyncChange).where(
            SyncChange.resource_kind == kind, SyncChange.resource_id == item_id
        ).order_by(SyncChange.seq))).scalars().all()
        assert [(row.version, row.operation) for row in changes] == [(1, "create"), (2, "update"), (3, "delete")]
        record = await session.get(SyncRecord, (item.owner_id, kind, item_id))
        assert record is not None and record.version == item.version
        assert record.deleted_at is not None


@pytest.mark.parametrize("kind,make,model", [
    ("task", capture.create_task, Task), ("note", capture.create_note, Note),
])
async def test_rollback_discards_domain_row_projection_and_change(sync_domain_setup, kind, make, model):
    client, sessions, _ = sync_domain_setup
    async with sessions() as session:
        owner_id = (await session.execute(select(User.id))).scalar_one()
        item = await make(session, owner_id, title="Rolled back capture")
        item_id = item.id
        # Confirm the writer ran before rollback, avoiding a vacuous no-log test.
        change = (await session.execute(select(SyncChange).where(
            SyncChange.owner_id == owner_id, SyncChange.resource_kind == kind,
            SyncChange.resource_id == item_id,
        ))).scalar_one()
        assert change.version == item.version
        await session.rollback()
    async with sessions() as session:
        assert await session.get(model, item_id) is None
        assert await session.get(SyncRecord, (owner_id, kind, item_id)) is None
        assert (await session.execute(select(SyncChange).where(
            SyncChange.owner_id == owner_id, SyncChange.resource_id == item_id,
        ))).scalar_one_or_none() is None
    assert (await client.get("/api/v1/sync/pull")).json()["changes"] == []
    assert (await client.get("/api/v1/sync/bootstrap")).json()["resources"] == []


async def test_stale_push_after_server_edit_reports_domain_version_and_preserves_edit(sync_domain_setup):
    client, sessions, device_id = sync_domain_setup
    created = await client.post("/api/v1/tasks", json={"title": "Original"})
    assert created.status_code == 200, created.text
    item = created.json()
    updated = await client.patch("/api/v1/tasks/" + item["id"], json={"title": "Server edit", "version": item["version"]})
    assert updated.status_code == 200, updated.text
    response = await client.post("/api/v1/sync/push", json={
        "device_id": device_id, "operations": [{
            "operation_id": "stale-domain-edit", "device_id": device_id,
            "resource_kind": "task", "resource_id": item["id"],
            "action": "update", "base_version": item["version"], "patch": {"title": "Offline stale edit"},
        }],
    })
    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["status"] == "conflict"
    assert result["version"] == updated.json()["version"]
    assert result["conflict"] == {"code": "VERSION_CONFLICT", "server_version": updated.json()["version"]}
    persisted = await client.get("/api/v1/tasks/" + item["id"])
    assert persisted.json()["title"] == "Server edit"
    assert persisted.json()["version"] == updated.json()["version"]
    async with sessions() as session:
        changes = (await session.execute(select(SyncChange).where(SyncChange.resource_id == item["id"]).order_by(SyncChange.seq))).scalars().all()
        assert [(row.version, row.operation) for row in changes] == [(1, "create"), (2, "update")]


async def test_telegram_task_is_visible_and_replay_does_not_duplicate_change(sync_domain_setup, monkeypatch):
    client, sessions, _ = sync_domain_setup
    owner_telegram_id = 111
    token = "123456:" + "s" * 30
    async with sessions() as session:
        owner_id = (await session.execute(select(User.id))).scalar_one()
        integration = TelegramIntegration(
            owner_id=owner_id, bot_id=1, bot_username="aelys_sync_test_bot", bot_name="Sync test",
            business_capable=True, encrypted_token=encrypt_secret(token), owner_telegram_id=owner_telegram_id,
        )
        session.add(integration)
        await session.commit()
        integration_id = integration.id

    class TelegramTransport:
        def __init__(self, supplied_token):
            assert supplied_token == token

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def get_me(self):
            return {"id": 1, "can_connect_to_business": True}

        async def get_webhook_info(self):
            return {"url": ""}

        async def get_updates(self, offset, timeout):
            return [{"update_id": 1, "message": {
                "text": "/task Telegram sync task\nDetails", "from": {"id": owner_telegram_id, "is_bot": False},
                "chat": {"id": owner_telegram_id, "type": "private"},
            }}]

        async def send_message(self, chat_id, text, **_kwargs):
            assert chat_id == owner_telegram_id and "Telegram sync task" in text
            # The confirmation must not race ahead of the domain/log commit.
            async with sessions() as session:
                assert await session.get(TelegramUpdateReceipt, (integration_id, 1)) is not None
                task = (await session.execute(select(Task))).scalar_one()
                change = (await session.execute(select(SyncChange).where(
                    SyncChange.owner_id == owner_id, SyncChange.resource_kind == "task", SyncChange.resource_id == task.id,
                ))).scalar_one()
                assert change.version == task.version
            return {"message_id": 500}

    monkeypatch.setattr(telegram_service, "TelegramClient", TelegramTransport)
    assert await telegram_service.poll_once(integration_id, timeout=0) == 1
    assert await telegram_service.poll_once(integration_id, timeout=0) == 0
    response = await client.get("/api/v1/tasks")
    assert response.status_code == 200, response.text
    tasks = response.json()
    assert len(tasks) == 1 and tasks[0]["description"] == "Details"
    await assert_sync_state(client, "task", tasks[0]["id"], tasks[0]["version"], "create", {"title": "Telegram sync task"})


async def test_ai_task_creation_is_committed_and_visible_to_sync(sync_domain_setup, monkeypatch):
    client, _, _ = sync_domain_setup

    class ProviderTransport:
        calls = 0

        async def post(self, url, *, headers, json):
            self.calls += 1
            return HttpResponse(200, {
                "id": "sync-tool-response",
                "content": [{"type": "tool_use", "id": "sync-task-call", "name": "create_task", "input": {"title": "AI sync task"}}],
                "usage": {"input_tokens": 4, "output_tokens": 2},
            })

        async def stream(self, url, *, headers, json):
            self.calls += 1
            yield {"type": "message_start", "message": {"id": "sync-tool-response", "usage": {"input_tokens": 4, "output_tokens": 0}}}
            yield {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "sync-task-call", "name": "create_task"}}
            yield {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"title": "AI sync task"}'}}
            yield {"type": "message_delta", "usage": {"output_tokens": 2}}
            yield {"type": "message_stop"}

    transport = ProviderTransport()
    monkeypatch.setattr(ai_api, "HttpxTransport", lambda **_kwargs: transport)
    provider = await client.post("/api/v1/ai/providers", json={
        "kind": "claude", "model_policy": {"models": [{
            "name": "sync-tool-model", "capabilities": ["tool_calling"], "context_tokens": 4096,
        }]},
    })
    assert provider.status_code == 200, provider.text
    secret = await client.put("/api/v1/ai/providers/" + provider.json()["id"] + "/secret", json={"api_key": "test-only-sync-provider-key"})
    assert secret.status_code == 200, secret.text
    conversation = await client.post("/api/v1/ai/conversations", json={"tool_scope": {"scopes": ["tasks.write"]}})
    assert conversation.status_code == 200, conversation.text
    run = await client.post("/api/v1/ai/runs", json={
        "conversation_id": conversation.json()["id"], "message": "Create a task",
        "routing": {"provider": "claude", "model": "sync-tool-model"}, "idempotency_key": "ai-sync-task",
    })
    assert run.status_code == 200, run.text
    events = await client.get("/api/v1/ai/runs/" + run.json()["id"] + "/events")
    assert events.status_code == 200, events.text
    assert "event: ai.tool.result" in events.text and "event: ai.run.completed" in events.text
    assert "event: ai.run.failed" not in events.text
    assert "event: ai.action.proposed" in events.text
    assert (await client.get("/api/v1/tasks")).json() == []
    action = (await client.get("/api/v1/ai/conversations/" + conversation.json()["id"] + "/actions")).json()[0]
    approved = await client.post("/api/v1/ai/actions/" + action["id"] + "/approve")
    assert approved.status_code == 200 and approved.json()["status"] == "approved", approved.text
    response = await client.get("/api/v1/tasks")
    assert response.status_code == 200, response.text
    tasks = response.json()
    assert len(tasks) == 1 and tasks[0]["title"] == "AI sync task"
    await assert_sync_state(client, "task", tasks[0]["id"], tasks[0]["version"], "create", {"title": "AI sync task"})


PUSH_DOMAIN_CASES = [
    ("task", "/tasks", Task, {
        "title": "Device task", "description": "Original details", "status": "in_progress", "priority": 2,
        "due_at": "2026-11-05T17:00:00Z", "due_timezone": "Asia/Almaty",
    }, "title"),
    ("note", "/notes", Note, {
        "title": "Device note", "markdown_body": "Device initial body", "folder": "Inbox", "tags": ["sync"], "pinned": True,
    }, "title"),
    ("event", "/calendar/events", CalendarEvent, {
        "title": "Device event", "description": "Original details", "starts_at": "2026-11-05T12:00:00Z",
        "ends_at": "2026-11-05T13:00:00Z", "timezone": "Asia/Almaty", "all_day": False,
    }, "title"),
    ("project", "/projects", Project, {"name": "Device project", "description": "Original details", "status": "active"}, "name"),
]


async def push_domain(client, device_id, kind, item_id, action, base_version, patch, operation_id=None):
    return await client.post("/api/v1/sync/push", json={
        "device_id": device_id, "operations": [{
            "operation_id": operation_id or str(uuid4()), "device_id": device_id,
            "resource_kind": kind, "resource_id": item_id,
            "action": action, "base_version": base_version, "patch": patch,
        }],
    })


@pytest.mark.parametrize("kind,path,model,body,label", PUSH_DOMAIN_CASES)
async def test_device_push_domain_roundtrip_preserves_versions_fields_and_revisions(
    sync_domain_setup, kind, path, model, body, label
):
    client, sessions, device_id = sync_domain_setup
    item_id, create_op, retry_op = (str(uuid4()) for _ in range(3))
    response = await push_domain(client, device_id, kind, item_id, "create", 0, body, create_op)
    assert response.status_code == 200, response.text
    assert response.json()["results"][0]["status"] == "applied"
    assert response.json()["results"][0]["version"] == 1
    replay = await push_domain(client, device_id, kind, item_id, "create", 0, body, create_op)
    assert replay.status_code == 200, replay.text
    assert replay.json()["results"] == response.json()["results"]
    cursor = await assert_sync_state(client, kind, item_id, 1, "create", {label: body[label]})
    created = await client.get("/api/v1" + path + "/" + item_id)
    assert created.status_code == 200, created.text
    assert created.json()["id"] == item_id and created.json()["version"] == 1
    for field, value in body.items():
        if field in {"starts_at", "ends_at", "due_at"}:
            assert datetime.fromisoformat(created.json()[field]) == datetime.fromisoformat(value)
        else:
            assert created.json()[field] == value
    listing = await client.get("/api/v1" + path)
    assert listing.status_code == 200, listing.text
    assert [row["id"] for row in listing.json()] == [item_id]

    rest_body = {**body, label: "REST edit"}
    if kind == "note":
        rest_body["markdown_body"] = "REST edited body"
    else:
        rest_body["version"] = 1
    edited = await client.patch("/api/v1" + path + "/" + item_id, json=rest_body, params={"version": 1})
    assert edited.status_code == 200, edited.text
    assert edited.json()["version"] == 2
    cursor = await assert_sync_state(client, kind, item_id, 2, "update", {label: "REST edit"}, cursor)
    # Deliberately omit required title/name and calendar instants on device update.
    # The mounted push must validate the patch over the authoritative domain row.
    patch = {"markdown_body": "Device retry body"} if kind == "note" else {"description": "Device retry details"}
    stale = await push_domain(client, device_id, kind, item_id, "update", 1, patch)
    assert stale.status_code == 200, stale.text
    conflict = stale.json()["results"][0]
    assert conflict["status"] == "conflict" and conflict["version"] == 2
    assert conflict["conflict"]["code"] == "VERSION_CONFLICT"
    assert conflict["conflict"]["server_version"] == 2
    if kind == "note":
        branches = {branch["branch"]: branch for branch in conflict["conflict"]["branches"]}
        assert branches["server"]["payload"]["markdown_body"] == "REST edited body"
        assert branches["client"]["payload"] == patch
    unchanged = await client.get("/api/v1" + path + "/" + item_id)
    assert unchanged.status_code == 200 and unchanged.json() == edited.json()
    after_conflict = await client.get("/api/v1/sync/pull", params={"cursor": cursor})
    assert after_conflict.status_code == 200 and after_conflict.json()["changes"] == []

    retried = await push_domain(client, device_id, kind, item_id, "update", 2, patch, retry_op)
    assert retried.status_code == 200, retried.text
    assert retried.json()["results"][0]["status"] == "applied"
    assert retried.json()["results"][0]["version"] == 3
    replay = await push_domain(client, device_id, kind, item_id, "update", 2, patch, retry_op)
    assert replay.status_code == 200 and replay.json()["results"] == retried.json()["results"]
    cursor = await assert_sync_state(client, kind, item_id, 3, "update", {label: "REST edit", **patch}, cursor)
    current = await client.get("/api/v1" + path + "/" + item_id)
    assert current.status_code == 200, current.text
    expected = {**edited.json(), **patch, "version": 3}
    actual = current.json()
    if "updated_at" in expected:
        assert datetime.fromisoformat(actual.pop("updated_at")) >= datetime.fromisoformat(expected.pop("updated_at"))
    assert actual == expected
    if kind == "note":
        revisions = await client.get(f"/api/v1/notes/{item_id}/revisions")
        assert revisions.status_code == 200, revisions.text
        assert [(row["base_version"], row["revision_no"], row["body"], row["source_device_id"]) for row in revisions.json()] == [
            (0, 1, "Device initial body", device_id), (1, 2, "REST edited body", device_id),
            (2, 3, "Device retry body", device_id),
        ]

    delete_op = str(uuid4())
    deleted = await push_domain(client, device_id, kind, item_id, "delete", 3, {}, delete_op)
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["results"][0]["status"] == "applied"
    assert deleted.json()["results"][0]["version"] == 4
    replay = await push_domain(client, device_id, kind, item_id, "delete", 3, {}, delete_op)
    assert replay.status_code == 200 and replay.json()["results"] == deleted.json()["results"]
    assert (await client.get("/api/v1" + path + "/" + item_id)).status_code == 404
    listing = await client.get("/api/v1" + path)
    assert listing.status_code == 200 and listing.json() == []
    await assert_sync_state(client, kind, item_id, 4, "delete", {}, cursor)
    async with sessions() as session:
        item = await session.get(model, item_id)
        assert item.version == 4 and item.deleted_at is not None
        changes = (await session.execute(select(SyncChange).where(
            SyncChange.owner_id == item.owner_id, SyncChange.resource_kind == kind, SyncChange.resource_id == item_id,
        ).order_by(SyncChange.seq))).scalars().all()
        assert [(row.version, row.operation) for row in changes] == [(1, "create"), (2, "update"), (3, "update"), (4, "delete")]
        record = await session.get(SyncRecord, (item.owner_id, kind, item_id))
        assert record is not None and record.version == 4 and record.deleted_at is not None
        if kind == "note":
            revisions = (await session.execute(select(NoteRevision).where(NoteRevision.note_id == item_id))).scalars().all()
            assert sorted(row.revision_no for row in revisions) == [1, 2, 3]


async def seed_foreign_domain(sessions, kind, model, body):
    # A real committed foreign log also exercises owner scoping of sync reads.
    from app.sync.change_log import record_domain_change

    async with sessions() as session:
        foreign_owner = str(uuid4())
        session.add(User(id=foreign_owner))
        await session.flush()
        values = {**body}
        for field in ("starts_at", "ends_at", "due_at"):
            if values.get(field):
                values[field] = datetime.fromisoformat(values[field])
        values["name" if kind == "project" else "title"] = "Foreign private content"
        item = model(owner_id=foreign_owner, version=7, **values)
        session.add(item)
        await record_domain_change(session, item)
        item_id = item.id
        await session.commit()
        return foreign_owner, item_id


@pytest.mark.parametrize("action", ["create", "update", "delete"])
@pytest.mark.parametrize("kind,path,model,body,label", PUSH_DOMAIN_CASES)
async def test_push_denies_foreign_domain_id_without_exposing_content(
    sync_domain_setup, action, kind, path, model, body, label
):
    client, sessions, device_id = sync_domain_setup
    foreign_owner, item_id = await seed_foreign_domain(sessions, kind, model, body)
    response = await push_domain(client, device_id, kind, item_id, action, 7, {} if action == "delete" else body)
    assert response.status_code == 403, response.text
    assert foreign_owner not in response.text and "Foreign private content" not in response.text
    assert (await client.get("/api/v1" + path + "/" + item_id)).status_code == 404
    listing = await client.get("/api/v1" + path)
    assert listing.status_code == 200 and listing.json() == []
    pulled = await client.get("/api/v1/sync/pull")
    snapshot = await client.get("/api/v1/sync/bootstrap")
    assert pulled.status_code == snapshot.status_code == 200
    assert pulled.json()["changes"] == [] and snapshot.json()["resources"] == []
    async with sessions() as session:
        item = await session.get(model, item_id)
        assert item.owner_id == foreign_owner and item.version == 7 and item.deleted_at is None
        assert getattr(item, label) == "Foreign private content"
        changes = (await session.execute(select(SyncChange).where(SyncChange.resource_id == item_id))).scalars().all()
        assert [(row.owner_id, row.version) for row in changes] == [(foreign_owner, 7)]


@pytest.mark.parametrize("action", ["create", "update"])
@pytest.mark.parametrize("kind,field,foreign_kind", [
    ("task", "project_id", "project"), ("note", "project_id", "project"), ("event", "project_id", "project"),
    ("task", "parent_task_id", "task"), ("note", "parent_id", "note"), ("event", "linked_task_id", "task"),
])
async def test_push_denies_foreign_reference_without_partial_write(sync_domain_setup, action, kind, field, foreign_kind):
    client, sessions, device_id = sync_domain_setup
    cases = {case[0]: case for case in PUSH_DOMAIN_CASES}
    _, path, model, body, _ = cases[kind]
    _, _, foreign_model, foreign_body, _ = cases[foreign_kind]
    foreign_owner, foreign_id = await seed_foreign_domain(sessions, foreign_kind, foreign_model, foreign_body)
    item_id = str(uuid4())
    before = None
    if action == "update":
        created = await push_domain(client, device_id, kind, item_id, "create", 0, body)
        assert created.status_code == 200, created.text
        before = (await client.get("/api/v1" + path + "/" + item_id)).json()
    patch = {**body, field: foreign_id} if action == "create" else {field: foreign_id}
    response = await push_domain(client, device_id, kind, item_id, action, 1 if before else 0, patch)
    assert response.status_code == 404, response.text
    assert all(value not in response.text for value in (foreign_owner, foreign_id, "Foreign private content"))
    current = await client.get("/api/v1" + path + "/" + item_id)
    if before:
        assert current.status_code == 200 and current.json() == before
        await assert_sync_state(client, kind, item_id, 1, "create", {})
    else:
        assert current.status_code == 404
    pulled = await client.get("/api/v1/sync/pull")
    snapshot = await client.get("/api/v1/sync/bootstrap")
    assert pulled.status_code == snapshot.status_code == 200
    assert len(pulled.json()["changes"]) == len(snapshot.json()["resources"]) == (1 if before else 0)
    assert "Foreign private content" not in pulled.text + snapshot.text
    assert foreign_id not in pulled.text + snapshot.text
    async with sessions() as session:
        owner_id = (await session.execute(select(User.id).where(User.id != foreign_owner))).scalar_one()
        changes = (await session.execute(select(SyncChange).where(
            SyncChange.owner_id == owner_id, SyncChange.resource_id == item_id,
        ))).scalars().all()
        assert [(row.version, row.operation) for row in changes] == ([(1, "create")] if before else [])
        if not before:
            assert await session.get(model, item_id) is None
            assert await session.get(SyncRecord, (owner_id, kind, item_id)) is None
