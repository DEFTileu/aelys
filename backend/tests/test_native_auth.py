"""Real database contract tests; credentials and records are synthetic."""
import asyncio
from datetime import timedelta

import pytest
from app.core import db
from app.core.db import Base
from app.core.models import AuthSession, Device, User, now
from app.core.security import create_token, decode_token, token_hash
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

PREFIX = "/api/v1/auth/native"
LOGIN = {"email": "native@test.example", "password": "synthetic-native-password", "platform": "macos", "display_name": "Synthetic Mac"}


@pytest.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/native.db")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://native.test") as client:
        yield client
    await engine.dispose()


@pytest.mark.asyncio
async def test_native_rotation_crud_restart_and_logout(client):
    assert (await client.get(f"{PREFIX}/status")).json() == {"initialized": False, "password_setup": True}
    created = await client.post(f"{PREFIX}/bootstrap", json=LOGIN)
    assert created.status_code == 200, created.text
    assert "no-store" in created.headers["cache-control"]
    assert "set-cookie" not in created.headers
    first = created.json()
    assert set(first) == {"access_token", "refresh_token", "owner_id", "device_id", "token_type", "expires_in"}
    auth = {"Authorization": f"Bearer {first['access_token']}"}
    identity = (await client.get("/api/v1/me", headers=auth)).json()
    assert identity["id"] == first["owner_id"] and identity["device_id"] == first["device_id"]
    task = await client.post("/api/v1/tasks", headers=auth, json={"title": "Native task"})
    assert task.status_code == 200, task.text
    assert (await client.get("/api/v1/tasks", headers=auth)).json()[0]["id"] == task.json()["id"]
    assert (await client.get(f"{PREFIX}/status")).json() == {"initialized": True, "password_setup": True}
    rotated = (await client.post(f"{PREFIX}/refresh", json={"refresh_token": first["refresh_token"]})).json()
    assert rotated["refresh_token"] != first["refresh_token"]
    assert rotated["device_id"] == first["device_id"]
    assert decode_token(rotated["access_token"])["sid"] == decode_token(first["access_token"])["sid"]
    assert (await client.get("/api/v1/me", headers=auth)).status_code == 200
    assert (await client.post(f"{PREFIX}/refresh", json={"refresh_token": first["refresh_token"]})).status_code == 401
    # A fresh cookie-free client models restart with only the saved refresh secret.
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://native.test") as fresh:
        restored = await fresh.post(f"{PREFIX}/refresh", json={"refresh_token": rotated["refresh_token"]})
        assert restored.status_code == 200
        assert restored.json()["owner_id"] == first["owner_id"]
    secret = {"refresh_token": restored.json()["refresh_token"]}
    assert (await client.post(f"{PREFIX}/logout", json=secret)).json() == {"logged_out": True}
    assert (await client.post(f"{PREFIX}/logout", json=secret)).status_code == 200
    assert (await client.get("/api/v1/me", headers=auth)).status_code == 401
    assert (await client.post(f"{PREFIX}/refresh", json=secret)).status_code == 401


@pytest.mark.asyncio
async def test_credentials_device_binding_and_revocation(client):
    first = (await client.post(f"{PREFIX}/bootstrap", json=LOGIN)).json()
    assert (await client.post(f"{PREFIX}/login", json={**LOGIN, "password": "bad-password"})).status_code == 401
    second = (await client.post(f"{PREFIX}/login", json={**LOGIN, "platform": "android"})).json()
    assert second["device_id"] != first["device_id"]
    async with db.SessionLocal() as session:
        record = (await session.execute(select(AuthSession).where(AuthSession.device_id == first["device_id"]))).scalar_one()
        assert record.refresh_token_hash == token_hash(first["refresh_token"])
        assert first["refresh_token"] not in record.refresh_token_hash
        device = await session.get(Device, first["device_id"])
        assert device.platform == "macos" and record.owner_id == device.owner_id
    auth = {"Authorization": f"Bearer {first['access_token']}"}
    assert (await client.post(f"/api/v1/devices/{second['device_id']}/revoke", headers=auth)).status_code == 200
    assert (await client.post(f"{PREFIX}/refresh", json={"refresh_token": second["refresh_token"]})).status_code == 401
    assert (await client.get("/api/v1/me", headers={"Authorization": f"Bearer {second['access_token']}"})).status_code == 401
    assert (await client.get("/api/v1/me", headers=auth)).status_code == 200


@pytest.mark.asyncio
async def test_rotation_is_single_use_under_concurrency(client):
    first = (await client.post(f"{PREFIX}/bootstrap", json=LOGIN)).json()
    responses = await asyncio.gather(*(client.post(f"{PREFIX}/refresh", json={"refresh_token": first["refresh_token"]}) for _ in range(2)))
    assert sorted(result.status_code for result in responses) == [200, 401]


@pytest.mark.asyncio
async def test_shared_bootstrap_lock_preserves_single_owner(client):
    responses = await asyncio.gather(
        client.post(f"{PREFIX}/bootstrap", json=LOGIN),
        client.post("/api/v1/auth/bootstrap", json={"email": "other@test.example", "password": "other-synthetic-password"}),
    )
    assert sorted(result.status_code for result in responses) == [200, 409]
    async with db.SessionLocal() as session:
        assert len((await session.execute(select(User))).scalars().all()) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [{"Origin": "null"}, {"Origin": "https://native.test"}, {"Sec-Fetch-Site": "same-origin"}, {"Sec-Fetch-Mode": "cors"}])
async def test_browser_headers_cannot_use_native_transport(client, headers):
    for operation in ("bootstrap", "login", "refresh", "logout"):
        response = await client.post(f"{PREFIX}/{operation}", headers=headers, json=LOGIN)
        assert response.status_code == 403
        assert response.headers["cache-control"] == "no-store"
    assert (await client.get(f"{PREFIX}/status", headers=headers)).status_code == 403


@pytest.mark.asyncio
async def test_invalid_auth_validation_never_reflects_secrets(client):
    secret = "synthetic-secret-that-must-not-be-reflected"
    for path, body in (("login", {**LOGIN, "password": {"secret": secret}}), ("refresh", {"refresh_token": {"secret": secret}}), ("login", {**LOGIN, "unexpected": secret})):
        response = await client.post(f"{PREFIX}/{path}", json=body)
        assert response.status_code == 422
        assert secret not in response.text and LOGIN["password"] not in response.text


@pytest.mark.asyncio
async def test_expired_and_mismatched_sessions_cannot_refresh_but_can_logout(client):
    first = (await client.post(f"{PREFIX}/bootstrap", json=LOGIN)).json()
    async with db.SessionLocal() as session:
        record = (await session.execute(select(AuthSession))).scalar_one()
        record.expires_at = now() - timedelta(seconds=1)
        await session.commit()
    assert (await client.post(f"{PREFIX}/refresh", json={"refresh_token": first["refresh_token"]})).status_code == 401
    # Expired refresh JWT can still revoke its exact stored session.
    expired = create_token(first["owner_id"], "refresh", -100, first["device_id"], record.id)
    async with db.SessionLocal() as session:
        record = await session.get(AuthSession, record.id)
        record.refresh_token_hash = token_hash(expired)
        await session.commit()
    assert (await client.post(f"{PREFIX}/logout", json={"refresh_token": expired})).status_code == 200
    assert (await client.get("/api/v1/me", headers={"Authorization": f"Bearer {first['access_token']}"})).status_code == 401


@pytest.mark.asyncio
async def test_owner_and_browser_sessions_are_not_native_refresh_credentials(client):
    native = (await client.post(f"{PREFIX}/bootstrap", json=LOGIN)).json()
    legacy = (await client.post("/api/v1/auth/login", json={key: LOGIN[key] for key in ("email", "password")})).json()
    assert (await client.post(f"{PREFIX}/refresh", json={"refresh_token": legacy["refresh_token"]})).status_code == 401
    assert (await client.post(f"{PREFIX}/refresh", json={"refresh_token": native["access_token"]})).status_code == 401
    assert (await client.post(f"{PREFIX}/logout", json={"refresh_token": "unknown-secret"})).status_code == 200
    assert (await client.get("/api/v1/me", headers={"Authorization": f"Bearer {native['access_token']}"})).status_code == 200
