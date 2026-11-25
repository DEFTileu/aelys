from datetime import UTC, datetime

import pytest
from app.core import db
from app.core.db import Base
from app.core.models import AuditLog, User
from app.main import app
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def system_client(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/system-status.db")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        created = await client.post(
            "/api/v1/auth/browser/bootstrap",
            json={"email": "status@example.test", "password": "disposable-status-test-password"},
            headers={"X-Aelys-Browser": "1", "Origin": "http://test"},
        )
        assert created.status_code == 200, created.text
        auth = {"Authorization": f"Bearer {created.json()['access_token']}"}
        async with db.SessionLocal() as session:
            owner_id = (await session.execute(select(User.id))).scalar_one()
        yield client, auth, owner_id
    await engine.dispose()


@pytest.mark.asyncio
async def test_system_endpoints_require_authentication(system_client):
    client, _, _ = system_client

    for path in ("/api/v1/system/status", "/api/v1/system/events"):
        response = await client.get(path)
        assert response.status_code == 401
        assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_system_status_reports_authenticated_database_and_process_health(system_client):
    client, auth, _ = system_client

    response = await client.get("/api/v1/system/status", headers=auth)

    assert response.status_code == 200
    payload = response.json()
    assert payload["api"] == "ok"
    assert payload["database"] == "ok"
    assert isinstance(payload["uptime_seconds"], (int, float))
    assert payload["uptime_seconds"] >= 0
    assert datetime.fromisoformat(payload["checked_at"]).tzinfo is not None


@pytest.mark.asyncio
async def test_system_events_are_owner_filtered_and_expose_only_allowlisted_fields(system_client):
    client, auth, owner_id = system_client
    async with db.SessionLocal() as session:
        session.add_all(
            [
                AuditLog(
                    id="owned-event",
                    owner_id=owner_id,
                    action="device.register_key",
                    actor="private-actor",
                    scope="private-scope",
                    decision="allow",
                    outcome="enrolled",
                    correlation_id="private-correlation",
                    redacted_metadata={"secret": "private-metadata"},
                    created_at=datetime(2026, 1, 2, tzinfo=UTC),
                ),
                AuditLog(
                    id="unknown-event",
                    owner_id=owner_id,
                    action="private arbitrary action",
                    actor="private-actor-2",
                    scope="private-scope-2",
                    decision="private decision",
                    outcome="private outcome",
                    correlation_id="private-correlation-2",
                    redacted_metadata={"secret": "private-metadata-2"},
                    created_at=datetime(2026, 1, 3, tzinfo=UTC),
                ),
                AuditLog(
                    id="other-owner-event",
                    owner_id="another-owner",
                    action="device.register_key",
                    actor="other-owner-actor",
                    scope="other-owner-scope",
                    decision="allow",
                    outcome="enrolled",
                    correlation_id="other-owner-correlation",
                    redacted_metadata={"secret": "other-owner-metadata"},
                    created_at=datetime(2026, 1, 4, tzinfo=UTC),
                ),
            ]
        )
        await session.commit()

    response = await client.get("/api/v1/system/events", headers=auth)

    assert response.status_code == 200
    items = response.json()["items"]
    assert [item["id"] for item in items] == ["unknown-event", "owned-event"]
    assert all(set(item) == {"id", "action", "decision", "outcome", "created_at"} for item in items)
    assert items[0]["action"] == "other"
    assert items[0]["decision"] == "other"
    assert items[0]["outcome"] == "other"
    assert items[1]["action"] == "device.register_key"
    assert items[1]["decision"] == "allow"
    assert items[1]["outcome"] == "enrolled"
    assert items[1]["created_at"].endswith("Z") or items[1]["created_at"].endswith("+00:00")
    serialized = response.text
    for private_value in (
        "private-actor",
        "private-scope",
        "private-correlation",
        "private-metadata",
        "other-owner-event",
    ):
        assert private_value not in serialized


@pytest.mark.asyncio
async def test_system_events_limit_is_between_one_and_one_hundred(system_client):
    client, auth, _ = system_client

    for limit in (0, 101):
        response = await client.get("/api/v1/system/events", params={"limit": limit}, headers=auth)
        assert response.status_code == 422


@pytest.mark.asyncio
async def test_system_responses_disable_caching(system_client):
    client, auth, _ = system_client

    for path in ("/api/v1/system/status", "/api/v1/system/events"):
        response = await client.get(path, headers=auth)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_system_status_does_not_claim_health_when_database_check_fails(system_client, monkeypatch):
    client, auth, _ = system_client

    async def unavailable(*args, **kwargs):
        raise HTTPException(status_code=503, detail="Database unavailable")

    monkeypatch.setattr("app.core.status_api.AsyncSession.scalar", unavailable)
    response = await client.get("/api/v1/system/status", headers=auth)

    assert response.status_code == 503
    assert response.json() != {"api": "ok", "database": "ok"}
