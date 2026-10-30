from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from app.core import db
from app.core.db import Base
from app.core.models import AuthSession, User
from app.core.security import create_token
from app.domains.api import TaskIn, TaskOut
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/tasks.db")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", sessions)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/auth/bootstrap", json={"email": "owner@test.example", "password": "tasks-test-password"})
        assert response.status_code == 200, response.text
        client.headers["Authorization"] = f"Bearer {response.json()['access_token']}"
        yield client, sessions
    await engine.dispose()


def assert_preserved(task, expected):
    for key in ("description", "project_id", "parent_task_id", "due_at", "due_timezone", "rrule", "priority"):
        assert task[key] == expected[key], key


@pytest.mark.asyncio
async def test_task_round_trip_and_versioned_full_input_updates(client):
    api, _ = client
    project_response = await api.post("/api/v1/projects", json={"name": "Project"})
    assert project_response.status_code == 200, project_response.text
    parent_response = await api.post("/api/v1/tasks", json={"title": "Parent"})
    assert parent_response.status_code == 200, parent_response.text
    body = {"title": "Local afternoon", "description": "Keep this detail", "project_id": project_response.json()["id"], "parent_task_id": parent_response.json()["id"], "status": "todo", "priority": 2, "due_at": "2026-10-29T14:35:00+05:00", "due_timezone": "Asia/Almaty", "rrule": "FREQ=WEEKLY;COUNT=4"}
    response = await api.post("/api/v1/tasks", json=body)
    assert response.status_code == 200, response.text
    created = response.json()
    expected = {**body, "due_at": "2026-10-29T09:35:00Z"}
    assert_preserved(created, expected)
    path = f"/api/v1/tasks/{created['id']}"
    listing = await api.get("/api/v1/tasks")
    assert listing.status_code == 200, listing.text
    listed = next(item for item in listing.json() if item["id"] == created["id"])
    fetched = await api.get(path)
    assert fetched.status_code == 200, fetched.text
    assert_preserved(listed, expected)
    assert_preserved(fetched.json(), expected)
    assert datetime.fromisoformat(fetched.json()["due_at"]).utcoffset() == timedelta(0)
    saved_response = await api.patch(path, json={**listed, "title": "Edited title"})
    assert saved_response.status_code == 200, saved_response.text
    saved = saved_response.json()
    assert saved["title"] == "Edited title"
    assert saved["version"] == listed["version"] + 1
    assert_preserved(saved, expected)
    toggled_response = await api.patch(path, json={**saved, "status": "completed"})
    assert toggled_response.status_code == 200, toggled_response.text
    toggled = toggled_response.json()
    assert toggled["status"] == "completed"
    assert toggled["version"] == saved["version"] + 1
    assert_preserved(toggled, expected)
    stale = await api.patch(path, json={**saved, "description": "stale overwrite", "due_at": None})
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "VERSION_CONFLICT"
    reloaded = await api.get(path)
    assert reloaded.status_code == 200, reloaded.text
    assert reloaded.json() == toggled


@pytest.mark.asyncio
async def test_task_owner_isolation_and_invalid_references(client):
    api, sessions = client
    project_response = await api.post("/api/v1/projects", json={"name": "Private"})
    assert project_response.status_code == 200, project_response.text
    project = project_response.json()
    task_response = await api.post("/api/v1/tasks", json={"title": "Private", "project_id": project["id"]})
    assert task_response.status_code == 200, task_response.text
    task = task_response.json()
    async with sessions() as session:
        other = User(email="other@test.example")
        session.add(other)
        await session.flush()
        auth_session = AuthSession(owner_id=other.id, refresh_token_hash="other-session", expires_at=datetime.now(UTC) + timedelta(hours=1))
        session.add(auth_session)
        await session.flush()
        token = create_token(other.id, "access", 3600, session_id=auth_session.id)
        await session.commit()
    api.headers["Authorization"] = f"Bearer {token}"
    assert (await api.get("/api/v1/tasks")).json() == []
    assert (await api.get(f"/api/v1/tasks/{task['id']}")).status_code == 404
    assert (await api.patch(f"/api/v1/tasks/{task['id']}", json=task)).status_code == 404
    assert (await api.post("/api/v1/tasks", json={"title": "Foreign project", "project_id": project["id"]})).status_code == 404
    assert (await api.post("/api/v1/tasks", json={"title": "Foreign parent", "parent_task_id": task["id"]})).status_code == 404
    assert (await api.post("/api/v1/tasks", json={"title": "Missing project", "project_id": "missing"})).status_code == 404


@pytest.mark.parametrize("model", [TaskIn, TaskOut])
@pytest.mark.parametrize("value,expected", [
    (None, None),
    (datetime(2026, 10, 29, 9, 35), datetime(2026, 10, 29, 9, 35, tzinfo=UTC)),
    (datetime.fromisoformat("2026-10-29T14:35:00+05:00"), datetime(2026, 10, 29, 9, 35, tzinfo=UTC)),
])
def test_task_models_normalize_nullable_and_legacy_due_dates(model, value, expected):
    fields = {"title": "Legacy", "due_at": value}
    if model is TaskOut:
        fields.update(id="legacy-id", version=1)
        result = model.model_validate(SimpleNamespace(**fields))
    else:
        result = model.model_validate(fields)
    assert result.due_at == expected
    if expected is not None:
        assert result.due_at.tzinfo is not None
        assert result.model_dump(mode="json")["due_at"] == "2026-10-29T09:35:00Z"
