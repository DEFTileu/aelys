import pytest
from app.core import db
from app.core.db import Base
from app.core.models import AgentRun, AuditLog, ProjectGrant
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient


@pytest.mark.asyncio
async def test_session_display_metadata_and_fail_closed_stop(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/agents.db")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        boot = await c.post("/api/v1/auth/bootstrap", json={"email": "agents@example.com", "password": "correct horse battery staple"})
        h = {"Authorization": f"Bearer {boot.json()['access_token']}"}
        project = (await c.post("/api/v1/projects", json={"name": "P"}, headers=h)).json()
        device = (await c.post("/api/v1/devices/enroll", json={"platform": "macos", "display_name": "Mac"}, headers=h)).json()
        grant = (await c.post(f"/api/v1/projects/{project['id']}/grants", headers=h, json={"device_id": device["device_id"], "policy_id": "policy-1"})).json()
        item = {"session_index_id": "s-1", "device_id": device["device_id"], "project_id": project["id"], "adapter": "claude_code", "state": "active",
                "workspace_path": "/Users/me/code/app", "sandbox": "project-only", "network": "blocked",
                "events": [{"kind": "tool.call", "message": "ran with token=abc123 and Bearer xyz"}] + [{"kind": "tick", "message": str(i)} for i in range(250)][:199]}
        bad = {**item, "session_index_id": "s-bad", "workspace_path": "/Users/me/../../etc"}
        too_many = {**item, "session_index_id": "s-many", "events": [{"kind": "tick", "message": "x"}] * 201}
        with TestClient(app) as sync, sync.websocket_connect("/api/v1/agents/channel", headers={"Authorization": f"Bearer {device['access_token']}"}) as socket:
            assert socket.receive_json()["type"] == "ready"
            for rejected in (bad, too_many, {**item, "network": "wide-open"}, {**item, "events": [{"kind": "x", "message": "m", "transcript": "no"}]}):
                socket.send_json({"type": "metadata_batch", "items": [rejected]})
                assert socket.receive_json() == {"type": "error", "code": "VALIDATION_ERROR"}
                assert socket.receive_json() == {"type": "metadata_ack", "count": 0}  # nothing stored
            socket.send_json({"type": "metadata_batch", "items": [item]})
            assert socket.receive_json() == {"type": "metadata_ack", "count": 1}
            # An older Mac that omits the display fields must not wipe them.
            socket.send_json({"type": "metadata_batch", "items": [{k: v for k, v in item.items() if k not in {"workspace_path", "sandbox", "network", "events"}}]})
            assert socket.receive_json()["type"] == "metadata_ack"
        listed = (await c.get("/api/v1/agents/sessions", headers=h)).json()
        assert len(listed) == 1
        session = listed[0]
        assert (session["workspace_path"], session["sandbox"], session["network"]) == ("/Users/me/code/app", "project-only", "blocked")
        assert len(session["events"]) == 200 and session["events"][0]["message"] == "ran with [redacted] and [redacted]"
        assert session["events"][0]["kind"] == "tool.call" and session["events"][0]["at"]

        # Fail closed: grant not isolation-validated, no active run, unknown session.
        stop = f"/api/v1/agents/sessions/{session['id']}/stop"
        assert (await c.post("/api/v1/agents/sessions/missing/stop", headers=h)).status_code == 404
        assert (await c.post(stop, headers=h)).json()["detail"]["code"] == "POLICY_DENIED"
        async with factory() as s:
            row = await s.get(ProjectGrant, grant["id"])
            row.isolation_validated = True
            await s.commit()
        assert (await c.post(stop, headers=h)).json()["detail"]["code"] == "NO_ACTIVE_RUN"
        async with factory() as s:
            s.add(AgentRun(id="run-1", owner_id=session["owner_id"], project_id=project["id"], device_id=device["device_id"], adapter="claude_code", status="running", request_policy_id="policy-1"))
            await s.commit()
        stopped = await c.post(stop, headers=h)
        assert stopped.status_code == 200 and stopped.json() == {"session_id": session["id"], "status": "stop_requested", "run_ids": ["run-1"]}
        async with factory() as s:
            assert (await s.get(AgentRun, "run-1")).cancellation_requested is True
            audit = (await s.execute(select(AuditLog).where(AuditLog.action == "agent.session.stop"))).scalars().all()
            assert len(audit) == 1 and audit[0].decision == "allow"
        # Another owner's device token cannot stop it.
        other = await c.post(stop)
        assert other.status_code in {401, 403}
    await engine.dispose()
