import base64
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from app.main import app
from app.core.db import Base
from app.core.models import AgentRun, ProjectGrant, now
from app.core import db
@pytest.mark.asyncio
async def test_public_contracts_and_remote_run_policy(tmp_path, monkeypatch):
    engine=create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/api.db"); factory=async_sessionmaker(engine,expire_on_commit=False)
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db,"SessionLocal",factory)
    async with AsyncClient(transport=ASGITransport(app=app),base_url="http://test") as c:
        boot=await c.post("/api/v1/auth/bootstrap",json={"email":"api@example.com","password":"correct horse battery staple"}); h={"Authorization":f"Bearer {boot.json()['access_token']}"}
        project=(await c.post("/api/v1/projects",json={"name":"P"},headers=h)).json()
        strict_patch=await c.patch(f"/api/v1/projects/{project['id']}",json={"name":"P2","unexpected":True},headers=h)
        assert strict_patch.status_code==422
        resource_a=(await c.post("/api/v1/resources",json={"kind":"note","entity_id":"resource-a","project_id":project["id"],"metadata":{}},headers=h)).json()
        resource_b=(await c.post("/api/v1/resources",json={"kind":"task","entity_id":"resource-b","project_id":project["id"],"metadata":{}},headers=h)).json()
        link=(await c.post("/api/v1/resource-links",json={"from_resource_id":resource_a["id"],"to_resource_id":resource_b["id"],"relation_type":"related"},headers=h)).json()
        assert (await c.delete(f"/api/v1/resource-links/{link['id']}",headers=h)).status_code==200
        note=(await c.post("/api/v1/notes",json={"title":"N","markdown_body":"body","project_id":project["id"]},headers=h)).json()
        assert (await c.get(f"/api/v1/notes/{note['id']}",headers=h)).status_code==200
        task=(await c.post("/api/v1/tasks",json={"title":"T","project_id":project["id"]},headers=h)).json()
        assert (await c.get(f"/api/v1/tasks/{task['id']}",headers=h)).status_code==200
        reminder=await c.post(f"/api/v1/tasks/{task['id']}/reminders",json={"task_id":task["id"],"notify_at":"2026-10-28T12:00:00Z","idempotency_key":"reminder-contract"},headers=h); assert reminder.status_code==200
        assert (await c.get(f"/api/v1/tasks/{task['id']}/reminders",headers=h)).status_code==200
        event=(await c.post("/api/v1/calendar/events",json={"title":"E","starts_at":"2026-10-28T12:00:00Z","ends_at":"2026-10-28T13:00:00Z","project_id":project["id"],"linked_task_id":task["id"]},headers=h)).json()
        assert (await c.get(f"/api/v1/calendar/events/{event['id']}",headers=h)).status_code==200
        account_response=await c.post("/api/v1/finance/accounts",json={"name":"Cash","currency":"USD"},headers=h)
        assert account_response.status_code==200
        checking=(await c.post("/api/v1/finance/accounts",json={"name":"Checking","currency":"USD"},headers=h)).json()
        cash=account_response.json()
        transfer_payload={"from_account_id":cash["id"],"to_account_id":checking["id"],"amount":"12.34","currency":"USD","occurred_at":"2026-10-28T00:00:00Z","idempotency_key":"transfer-contract-1"}
        transfer=await c.post("/api/v1/finance/transfers",json=transfer_payload,headers=h)
        assert transfer.status_code==200, transfer.text
        transfer_json=transfer.json(); assert transfer_json["debit"]["amount"] == "-12.34" and transfer_json["credit"]["amount"] == "12.34"
        replay_transfer=await c.post("/api/v1/finance/transfers",json={**transfer_payload,"amount":"99.00"},headers=h)
        assert replay_transfer.status_code==200 and replay_transfer.json()["transfer_id"]==transfer_json["transfer_id"]
        float_transfer=await c.post("/api/v1/finance/transfers",json={**transfer_payload,"idempotency_key":"transfer-contract-float","amount":1.25},headers=h)
        assert float_transfer.status_code==422
        mismatch_transfer=await c.post("/api/v1/finance/transfers",json={**transfer_payload,"idempotency_key":"transfer-contract-mismatch","currency":"EUR"},headers=h)
        assert mismatch_transfer.status_code==422
        category=(await c.post("/api/v1/finance/categories",json={"name":"Food"},headers=h)).json()
        budget=await c.post("/api/v1/finance/budgets",json={"category_id":category["id"],"currency":"USD","period_start":"2026-10-01T00:00:00Z","period_end":"2026-10-31T00:00:00Z","limit_amount":"100.00"},headers=h); assert budget.status_code==200, budget.text
        assert (await c.get("/api/v1/finance/categories",headers=h)).status_code==200 and (await c.get("/api/v1/finance/budgets",headers=h)).status_code==200
        mail_account=(await c.post("/api/v1/mail/accounts",json={"provider":"local_import"},headers=h)).json(); assert any(x["id"]==mail_account["id"] for x in (await c.get("/api/v1/mail/accounts",headers=h)).json())
        notification=(await c.post("/api/v1/notifications",json={"kind":"test","title":"Notice"},headers=h)).json(); assert (await c.post(f"/api/v1/notifications/{notification['id']}/read",headers=h)).status_code==200
        strict_notification=await c.post("/api/v1/notifications",json={"title":"Invalid","unexpected":True},headers=h); assert strict_notification.status_code==422
        device=(await c.post("/api/v1/devices/enroll",json={"platform":"macos","display_name":"Mac"},headers=h)).json()
        sync_h={"Authorization":f"Bearer {device['access_token']}"}
        grant=await c.post(f"/api/v1/projects/{project['id']}/grants",headers=h,json={"device_id":device["device_id"],"policy_id":"policy-1"}); assert grant.status_code==200 and grant.json()["isolation_validated"] is False
        assert (await c.get("/api/v1/agents/sessions",params={"project_id":project["id"]},headers=sync_h)).status_code == 200
        assert (await c.post("/api/v1/agents/sessions/search",json={"query":"secret","project_id":"11111111-1111-1111-1111-111111111111"},headers=sync_h)).status_code == 403
        provider=(await c.post("/api/v1/ai/providers",json={"kind":"claude","model_policy":{"models":[{"name":"claude-test","capabilities":["streaming"],"context_tokens":4096,"input_cost_per_1k":"0.01","output_cost_per_1k":"0.02"}]}},headers=h)).json()
        secret=await c.put(f"/api/v1/ai/providers/{provider['id']}/secret",json={"api_key":"sk-live-example-1234"},headers=h); assert secret.status_code==200 and secret.json()["last_four"]=="1234"
        listed=(await c.get("/api/v1/ai/providers",headers=h)).json(); assert "api_key" not in str(listed) and "sk-live" not in str(listed)
        rule=(await c.post("/api/v1/automations",headers=h,json={"name":"Task rule","trigger_kind":"task.created","conditions":{"project_id":project["id"]},"actions":[{"kind":"create_task","args":{"title":"Automated"}}],"policy_ref":"safe"})).json()
        event={"event_id":"99999999-9999-9999-9999-999999999999","event_kind":"task.created","payload":{"project_id":project["id"]}}
        dispatched=await c.post("/api/v1/automations/dispatch",headers=h,json=event); assert dispatched.status_code==200 and dispatched.json()["results"][0]["status"]=="completed"
        replay=await c.post("/api/v1/automations/dispatch",headers=h,json=event); assert replay.status_code==200 and replay.json()["results"][0]["status"]=="duplicate"
        assert (await c.delete(f"/api/v1/automations/{rule['id']}",headers=h)).status_code==200
        response=await c.post("/api/v1/agents/runs",json={"device_id":device["device_id"],"project_id":project["id"],"adapter":"codex_cli","task":"test","policy_id":"p","idempotency_key":"i"},headers=h)
        assert response.status_code==403 and response.json()["detail"]["code"]=="POLICY_DENIED"
        owner_id=(await c.get("/api/v1/me",headers=h)).json()["id"]
        async with factory() as session:
            persisted_grant=await session.get(ProjectGrant,grant.json()["id"])
            persisted_grant.isolation_validated=True
            persisted_grant.isolation_nonce=None
            run=AgentRun(owner_id=owner_id,project_id=project["id"],device_id=device["device_id"],adapter="codex_cli",status="starting",request_policy_id="policy-1",idempotency_key="lease-test",lease_id="lease-1",lease_until=now()+__import__("datetime").timedelta(minutes=5),task="test",result_metadata_json={})
            session.add(run)
            await session.commit()
            await session.refresh(run)
            run_id=run.id
        from app.core.config import get_settings
        unavailable=await c.post(f"/api/v1/agents/runs/{run_id}/credential-lease",json={"run_id":run_id,"device_id":device["device_id"],"project_id":project["id"],"grant_id":grant.json()["id"],"provider":"claude_api_key"},headers=sync_h)
        assert unavailable.status_code==503 and unavailable.json()["detail"]["code"]=="RUNTIME_CREDENTIALS_UNAVAILABLE"
        monkeypatch.setenv("AELYS_RUNTIME_SIGNING_KEY",base64.urlsafe_b64encode(bytes([9])*32).rstrip(b"=").decode())
        get_settings.cache_clear()
        lease=await c.post(f"/api/v1/agents/runs/{run_id}/credential-lease",json={"run_id":run_id,"device_id":device["device_id"],"project_id":project["id"],"grant_id":grant.json()["id"],"provider":"claude_api_key"},headers=sync_h)
        assert lease.status_code==200 and len(lease.json()["signature"])==64 and len(lease.json()["backend_public_key"])==32
        assert "sk-live-example" not in lease.text and "secret" not in lease.text
        foreign_project="11111111-1111-1111-1111-111111111111"
        foreign_task=await c.post("/api/v1/tasks",json={"title":"cross-owner ref","project_id":foreign_project},headers=h)
        assert foreign_task.status_code==404 and foreign_task.json()["detail"]["code"]=="NOT_FOUND"
        foreign_tx=await c.post("/api/v1/finance/transactions",json={"account_id":foreign_project,"currency":"USD","amount":"1.00","type":"expense","occurred_at":"2026-10-28T00:00:00Z"},headers=h)
        assert foreign_tx.status_code==404 and foreign_tx.json()["detail"]["code"]=="NOT_FOUND"
        owner_sync=await c.post("/api/v1/sync/push",json={"device_id":device["device_id"],"operations":[]},headers=h)
        assert owner_sync.status_code==403
        assert (await c.post("/api/v1/sync/push",json={"device_id":device["device_id"],"operations":[{"resource_kind":"agent_session","resource_id":"x","action":"create","base_version":0,"patch":{"transcript":"secret"}}]},headers=sync_h)).status_code in (400,422)
        pushed=await c.post("/api/v1/sync/push",json={"device_id":device["device_id"],"operations":[{"device_id":device["device_id"],"resource_id":"11111111-1111-1111-1111-111111111111","resource_kind":"task","action":"create","base_version":0,"patch":{"title":"offline"}}]},headers=sync_h)
        assert pushed.status_code==200, pushed.text
        cursor=pushed.json()["server_cursor"]
        assert "." in cursor
        pulled=await c.get("/api/v1/sync/pull",params={"cursor":"0"},headers=sync_h); assert pulled.status_code==200 and "." in pulled.json()["next_cursor"]
        acknowledged=await c.post("/api/v1/sync/ack",json={"device_id":device["device_id"],"cursor":pushed.json()["server_cursor"]},headers=sync_h)
        assert acknowledged.status_code==200 and acknowledged.json()["acknowledged_seq"] >= 1
        status=await c.get("/api/v1/sync/status",headers=sync_h)
        assert status.status_code==200 and status.json()["acknowledged_seq"] == acknowledged.json()["acknowledged_seq"]
        backwards=await c.post("/api/v1/sync/ack",json={"device_id":device["device_id"],"cursor":"0"},headers=sync_h)
        assert backwards.status_code==200 and backwards.json()["acknowledged_seq"] == acknowledged.json()["acknowledged_seq"]
        boot_sync=await c.get("/api/v1/sync/bootstrap",headers=sync_h); assert boot_sync.status_code==200 and any(x["resource_id"]=="11111111-1111-1111-1111-111111111111" for x in boot_sync.json()["resources"])
        tombstone_id="22222222-2222-2222-2222-222222222222"
        created=await c.post("/api/v1/sync/push",json={"device_id":device["device_id"],"operations":[{"operation_id":"33333333-3333-3333-3333-333333333333","device_id":device["device_id"],"resource_id":tombstone_id,"resource_kind":"task","action":"create","base_version":0,"patch":{"title":"tombstone"}}]},headers=sync_h)
        assert created.status_code==200 and created.json()["results"][0]["status"]=="applied"
        deleted=await c.post("/api/v1/sync/push",json={"device_id":device["device_id"],"operations":[{"operation_id":"44444444-4444-4444-4444-444444444444","device_id":device["device_id"],"resource_id":tombstone_id,"resource_kind":"task","action":"delete","base_version":1,"patch":{}}]},headers=sync_h)
        assert deleted.status_code==200 and deleted.json()["results"][0]["status"]=="applied"
        deleted_changes=await c.get("/api/v1/sync/pull",params={"cursor":"0"},headers=sync_h)
        assert any(change["resource_id"]==tombstone_id and change["operation"]=="delete" for change in deleted_changes.json()["changes"])
        tombstone_bootstrap=await c.get("/api/v1/sync/bootstrap",headers=sync_h)
        assert any(item["resource_id"]==tombstone_id and item["deleted"] is True for item in tombstone_bootstrap.json()["resources"])
        tombstone_ack=await c.post("/api/v1/sync/ack",json={"device_id":device["device_id"],"cursor":deleted.json()["server_cursor"]},headers=sync_h)
        assert tombstone_ack.status_code==200
        retained=await c.get("/api/v1/sync/bootstrap",headers=sync_h)
        assert any(item["resource_id"]==tombstone_id and item["deleted"] is True for item in retained.json()["resources"])
        with TestClient(app) as sync_client:
            with sync_client.websocket_connect("/api/v1/agents/channel", headers={"Authorization":f"Bearer {device['access_token']}"}) as socket:
                assert socket.receive_json()["type"]=="ready"
                socket.send_json({"type":"heartbeat"}); assert socket.receive_json()["type"]=="heartbeat_ack"
                socket.send_json({"type":"credential_lease","run_id":run_id,"project_id":project["id"],"grant_id":grant.json()["id"],"provider":"unsupported"})
                assert socket.receive_json()=={"type":"error","code":"VALIDATION_ERROR"}
                socket.send_json({"type":"credential_lease","run_id":run_id,"project_id":project["id"],"grant_id":grant.json()["id"],"provider":"claude_api_key"})
                channel_lease=socket.receive_json()
                assert channel_lease["type"]=="credential_lease_ack" and channel_lease["lease"]["provider"]=="claude_api_key"
                revoked=sync_client.post(f"/api/v1/devices/{device['device_id']}/revoke",headers=h)
                assert revoked.status_code==200
                socket.send_json({"type":"heartbeat"})
                try:
                    socket.receive_json()
                    raise AssertionError("revoked runtime channel remained active")
                except WebSocketDisconnect as exc:
                    assert exc.code==4403
    await engine.dispose()
