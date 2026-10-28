import pytest
import base64, json
from datetime import datetime, timedelta, timezone
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.main import app
from app.core.db import Base
from app.core import db
from app.agents.api import _verify_attestation, _verify_trusted_provenance
from app.core.config import get_settings
from app.core.models import Device
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
@pytest.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/test.db")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    await engine.dispose()
@pytest.mark.asyncio
async def test_bootstrap_login_project_and_device_revocation(client):
    r = await client.post("/api/v1/auth/bootstrap", json={"email":"owner@example.com","password":"correct horse battery staple"})
    assert r.status_code == 200
    token = r.json()["access_token"]; headers = {"Authorization":f"Bearer {token}"}
    assert (await client.post("/api/v1/projects", json={"name":"Aelys"}, headers=headers)).status_code == 200
    r = await client.post("/api/v1/devices/enroll", json={"platform":"macos","display_name":"Mac"}, headers=headers)
    assert r.status_code == 200
    device = r.json()
    await client.post(f"/api/v1/devices/{device['device_id']}/revoke", headers=headers)
    assert (await client.get("/api/v1/me", headers={"Authorization":f"Bearer {device['access_token']}"})).status_code == 401

@pytest.mark.asyncio
async def test_refresh_tokens_rotate_and_replay_is_rejected(client):
    r=await client.post("/api/v1/auth/bootstrap",json={"email":"rotate@example.com","password":"correct horse battery staple"}); old=r.json()["refresh_token"]
    rotated=await client.post("/api/v1/auth/refresh",json={"refresh_token":old}); assert rotated.status_code==200
    replay=await client.post("/api/v1/auth/refresh",json={"refresh_token":old}); assert replay.status_code==401
    assert (await client.get("/api/v1/me",headers={"Authorization":f"Bearer {old}"})).status_code==401

@pytest.mark.asyncio
async def test_logout_revokes_bound_access_and_refresh_session(client):
    r = await client.post("/api/v1/auth/bootstrap", json={"email":"logout@example.com","password":"correct horse battery staple"})
    access, refresh = r.json()["access_token"], r.json()["refresh_token"]
    headers = {"Authorization": f"Bearer {access}"}
    assert (await client.get("/api/v1/me", headers=headers)).status_code == 200
    assert (await client.post("/api/v1/auth/logout", headers=headers)).status_code == 200
    assert (await client.get("/api/v1/me", headers=headers)).status_code == 401
    assert (await client.post("/api/v1/auth/refresh", json={"refresh_token":refresh})).status_code == 401

def test_attestation_rejects_mutated_unsigned_request():
    key=Ed25519PrivateKey.generate(); public=key.public_key().public_bytes_raw()
    device_id="device-attestation-test"
    issued=datetime.now(timezone.utc); expires=issued+timedelta(minutes=5)
    request={"request_id":"request-1","device_id":device_id,"issued_at":issued.isoformat(),"expires_at":expires.isoformat(),"nonce":[1]*32,"body":{"type":"isolation_attestation","payload":{}}}
    signed_payload=json.dumps(request,separators=(",",":"),ensure_ascii=False)
    envelope={"request":request,"signed_payload":signed_payload,"public_key":list(public),"signature":list(key.sign(signed_payload.encode()))}
    device=Device(id=device_id,owner_id="owner",platform="macos",display_name="Mac",credential_hash="hash",public_key=base64.urlsafe_b64encode(public).rstrip(b"=").decode())
    assert _verify_attestation(envelope,device)
    envelope["request"]["expires_at"]=(expires+timedelta(minutes=1)).isoformat()
    assert not _verify_attestation(envelope,device)

def test_runtime_provenance_requires_signed_release_manifest(monkeypatch):
    key=Ed25519PrivateKey.generate(); public=key.public_key().public_bytes_raw()
    runtime_digest="a"*64; probe_digest="b"*64
    evidence={"profile_digest":"c"*64,"runtime_digest":runtime_digest,"probe_digest":probe_digest}
    monkeypatch.delenv("AELYS_RUNTIME_TRUST_PUBLIC_KEY",raising=False)
    monkeypatch.delenv("AELYS_RUNTIME_TRUST_MANIFEST",raising=False)
    get_settings.cache_clear()
    assert not _verify_trusted_provenance(evidence)
    payload={"manifest_id":"test-release","probe_digest":probe_digest,"runtime_digest":runtime_digest}
    canonical=json.dumps(payload,separators=(",",":"),sort_keys=True,ensure_ascii=False).encode()
    manifest={"payload":payload,"signature":list(key.sign(canonical))}
    monkeypatch.setenv("AELYS_RUNTIME_TRUST_PUBLIC_KEY",base64.urlsafe_b64encode(public).rstrip(b"=").decode())
    monkeypatch.setenv("AELYS_RUNTIME_TRUST_MANIFEST",base64.urlsafe_b64encode(json.dumps(manifest,separators=(",",":"),ensure_ascii=False).encode()).rstrip(b"=").decode())
    get_settings.cache_clear()
    assert _verify_trusted_provenance(evidence)
    tampered=dict(evidence,runtime_digest="d"*64)
    assert not _verify_trusted_provenance(tampered)
    get_settings.cache_clear()
