import os
import uuid
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.main import app
from app.core import db
from app.core.db import Base
from app.core.models import User
from app.core.security import create_token, hash_password

pytestmark = pytest.mark.asyncio

async def test_mounted_sync_route_uses_postgres_and_is_device_bound(monkeypatch):
    url=os.environ.get("AELYS_DATABASE_URL")
    if not url:
        pytest.skip("AELYS_DATABASE_URL is not configured")
    engine=create_async_engine(url); factory=async_sessionmaker(engine,expire_on_commit=False)
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db,"SessionLocal",factory)
    async with AsyncClient(transport=ASGITransport(app=app),base_url="http://test") as c:
        email=f"pg-{uuid.uuid4()}@example.com"
        boot=await c.post("/api/v1/auth/bootstrap",json={"email":email,"password":"correct horse battery staple"})
        if boot.status_code==409:
            boot=await c.post("/api/v1/auth/login",json={"email":"integration@example.com","password":"correct horse battery staple"})
        assert boot.status_code==200
        owner_headers={"Authorization":f"Bearer {boot.json()['access_token']}"}
        device=(await c.post("/api/v1/devices/enroll",headers=owner_headers,json={"platform":"macos","display_name":"pg"})).json()
        device_headers={"Authorization":f"Bearer {device['access_token']}"}
        operation_id=str(uuid.uuid4()); resource_id=str(uuid.uuid4()); body={"device_id":device["device_id"],"operations":[{"operation_id":operation_id,"device_id":device["device_id"],"resource_kind":"task","resource_id":resource_id,"action":"create","base_version":0,"patch":{"title":"postgres"}}]}
        first=await c.post("/api/v1/sync/push",headers=device_headers,json=body); assert first.status_code==200
        second=await c.post("/api/v1/sync/push",headers=device_headers,json=body); assert second.status_code==200 and second.json()["results"][0]["status"]=="applied"
        assert (await c.get("/api/v1/sync/pull",headers=owner_headers)).status_code==403
        pulled=await c.get("/api/v1/sync/pull",headers=device_headers); assert pulled.status_code==200 and any(change["resource_id"]==resource_id for change in pulled.json()["changes"])
        acknowledged=await c.post("/api/v1/sync/ack",headers=device_headers,json={"device_id":device["device_id"],"cursor":first.json()["server_cursor"]})
        assert acknowledged.status_code==200 and acknowledged.json()["acknowledged_seq"] >= 1
    await engine.dispose()


async def test_mounted_postgres_bootstrap_page_is_snapshot_bound_and_pull_reset_is_documented(monkeypatch):
    url=os.environ.get("AELYS_DATABASE_URL")
    if not url:
        pytest.skip("AELYS_DATABASE_URL is not configured")
    engine=create_async_engine(url); factory=async_sessionmaker(engine,expire_on_commit=False)
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db,"SessionLocal",factory)
    async with AsyncClient(transport=ASGITransport(app=app),base_url="http://test") as c:
        email=f"pg-bootstrap-{uuid.uuid4()}@example.com"
        async with factory() as session:
            owner=User(email=email,password_hash=hash_password("correct horse battery staple"))
            session.add(owner)
            await session.commit()
            owner_id=owner.id
        owner_headers={"Authorization":f"Bearer {create_token(owner_id,'access',900)}"}
        device=(await c.post("/api/v1/devices/enroll",headers=owner_headers,json={"platform":"macos","display_name":"pg"})).json()
        device_headers={"Authorization":f"Bearer {device['access_token']}"}

        async def push(resource_id):
            response=await c.post("/api/v1/sync/push",headers=device_headers,json={"device_id":device["device_id"],"operations":[{"operation_id":str(uuid.uuid4()),"device_id":device["device_id"],"resource_kind":"task","resource_id":resource_id,"action":"create","base_version":0,"patch":{"title":resource_id}}]})
            assert response.status_code==200, response.text

        await push("a")
        await push("b")
        first=await c.get("/api/v1/sync/bootstrap",params={"limit":1},headers=device_headers)
        assert first.status_code==200
        first_body=first.json()
        assert first_body["has_more"] is True
        assert first_body["next_page_token"]
        await push("c")
        second=await c.get("/api/v1/sync/bootstrap",params={"limit":1,"page_token":first_body["next_page_token"]},headers=device_headers)
        assert second.status_code==200
        assert [item["resource_id"] for item in second.json()["resources"]]==["b"]

        async with engine.begin() as connection:
            await connection.execute(text("CREATE TABLE IF NOT EXISTS sync_compaction_watermarks (owner_id VARCHAR(36) PRIMARY KEY, watermark INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMP WITH TIME ZONE NOT NULL)"))
            await connection.execute(text("INSERT INTO sync_compaction_watermarks (owner_id, watermark, updated_at) VALUES (:owner_id, :watermark, CURRENT_TIMESTAMP) ON CONFLICT (owner_id) DO UPDATE SET watermark = EXCLUDED.watermark, updated_at = EXCLUDED.updated_at"), {"owner_id": owner_id, "watermark": 1})
        stale=await c.get("/api/v1/sync/pull",params={"cursor":"0"},headers=device_headers)
        assert stale.status_code==409
        assert stale.json()["detail"]["error"]=={"code":"SYNC_RESET_REQUIRED","message":"The sync cursor is too old; bootstrap is required","details":{"compaction_watermark":1,"reset":"bootstrap"}}
    await engine.dispose()
