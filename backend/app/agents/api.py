from __future__ import annotations

import base64
import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from app.agents.trust import verify_signed_manifest
from app.core import db as core_db
from app.core.config import get_settings
from app.core.db import get_db
from app.core.models import (
    AgentRun,
    AgentSessionIndex,
    AuditLog,
    AuthSession,
    Device,
    Project,
    ProjectGrant,
    now,
)
from app.core.security import current_principal, decode_token
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

router=APIRouter()
class SessionSearch(BaseModel): query:str=Field(min_length=1,max_length=500); project_id:str|None=None; limit:int=20
class RunIn(BaseModel): device_id:str; project_id:str; adapter:str=Field(pattern="^(claude_code|codex_cli)$"); task:str=Field(min_length=1,max_length=10000); policy_id:str; idempotency_key:str
class CredentialLeaseIn(BaseModel):
    run_id: str
    device_id: str
    project_id: str
    grant_id: str
    provider: str = Field(pattern="^(claude_api_key|open_ai_api_key)$")
class MetadataItem(BaseModel):
    model_config=ConfigDict(extra="forbid")
    session_index_id: str = Field(min_length=1,max_length=100)
    device_id: str = Field(min_length=1,max_length=100)
    project_id: str|None = Field(default=None,max_length=100)
    adapter: str = Field(pattern="^(claude_code|codex_cli)$",max_length=30)
    started_at: datetime|None = None
    last_activity_at: datetime|None = None
    state: str = Field(pattern="^(active|completed|failed|archived|indexed)$",max_length=30)
    message_count: int|None = Field(default=None,ge=0,le=10_000_000)

METADATA_FIELDS={"session_index_id","device_id","project_id","adapter","started_at","last_activity_at","state","message_count"}
EVENT_STATES={"queued","starting","running","waiting_approval","completed","failed","cancelled","expired"}

async def _active_project_grant(db: AsyncSession, owner_id: str, project_id: str, device_id: str) -> ProjectGrant | None:
    return (await db.execute(select(ProjectGrant).where(
        ProjectGrant.owner_id == owner_id,
        ProjectGrant.project_id == project_id,
        ProjectGrant.device_id == device_id,
        ProjectGrant.revoked_at.is_(None),
    ))).scalar_one_or_none()

def _runtime_signing_key():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    configured=get_settings().runtime_signing_key
    if not configured:
        raise HTTPException(503,detail={"code":"RUNTIME_CREDENTIALS_UNAVAILABLE","message":"Runtime credential signing is not configured"})
    try:
        raw=base64.urlsafe_b64decode(configured + "=" * (-len(configured) % 4))
        if len(raw)!=32: raise ValueError
        return Ed25519PrivateKey.from_private_bytes(raw)
    except ValueError as exc:
        raise HTTPException(503,detail={"code":"RUNTIME_CREDENTIALS_UNAVAILABLE","message":"Runtime credential signing configuration is invalid"}) from exc

def _verify_trusted_provenance(evidence: dict) -> bool:
    """Verify runtime/probe digests against an operator-pinned signed manifest."""
    settings=get_settings()
    return verify_signed_manifest(settings.runtime_trust_public_key, settings.runtime_trust_manifest, evidence.get("runtime_digest"), evidence.get("probe_digest"))

async def _issue_credential_lease(run_id: str, body: CredentialLeaseIn, owner_id: str, device: Device, db: AsyncSession) -> dict:
    if device.id!=body.device_id:
        raise HTTPException(403,detail={"code":"FORBIDDEN","message":"Device-bound runtime credential required"})
    run=await db.get(AgentRun,run_id)
    grant=await db.get(ProjectGrant,body.grant_id)
    if not run or run.owner_id!=owner_id or run.id!=body.run_id or run.device_id!=device.id or run.project_id!=body.project_id:
        raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Agent run not found"})
    if not grant or grant.owner_id!=owner_id or grant.project_id!=run.project_id or grant.device_id!=device.id or grant.revoked_at or not grant.isolation_validated or grant.policy_id!=run.request_policy_id:
        raise HTTPException(403,detail={"code":"POLICY_DENIED","message":"Credential lease is outside the validated project grant"})
    current=datetime.now(UTC)
    lease_until=run.lease_until.replace(tzinfo=UTC) if run.lease_until and run.lease_until.tzinfo is None else run.lease_until
    if run.status not in {"starting","running","waiting_approval"} or not run.lease_id or not lease_until or lease_until<=current:
        raise HTTPException(409,detail={"code":"LEASE_UNAVAILABLE","message":"Agent run has no active lease"})
    key=_runtime_signing_key()
    expires_at=min(lease_until,current+timedelta(minutes=10))
    claims={"lease_id":str(uuid.uuid4()),"run_id":run.id,"device_id":device.id,"project_id":run.project_id,"grant_id":grant.id,"provider":body.provider,"issued_at":current.isoformat(),"expires_at":expires_at.isoformat(),"nonce":list(secrets.token_bytes(32))}
    signed_payload=json.dumps(claims,separators=(",",":"),ensure_ascii=False)
    return {**claims,"signed_payload":signed_payload,"signature":list(key.sign(signed_payload.encode())),"backend_public_key":list(key.public_key().public_bytes_raw())}

def _valid_run_transition(current: str, target: str) -> bool:
    allowed={
        "queued":{"starting","cancelled","expired"},
        "starting":{"running","failed","cancelled"},
        "running":{"waiting_approval","completed","failed","cancelled","expired"},
        "waiting_approval":{"running","completed","failed","cancelled","expired"},
    }
    return target in allowed.get(current, set())

def _verify_attestation(envelope:dict, device:Device) -> bool:
    import base64
    import json

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    try:
        if not device.public_key: return False
        request=envelope["request"]; signature=bytes(envelope["signature"]); public=bytes(envelope["public_key"])
        if request.get("body", {}).get("type") != "isolation_attestation": return False
        if public != base64.urlsafe_b64decode(device.public_key + "=" * (-len(device.public_key)%4)): return False
        payload=envelope.get("signed_payload")
        if not isinstance(payload,str) or json.loads(payload) != request:
            return False
        Ed25519PublicKey.from_public_bytes(public).verify(signature,payload.encode())
        issued=__import__("datetime").datetime.fromisoformat(request["issued_at"].replace("Z","+00:00"))
        expires=__import__("datetime").datetime.fromisoformat(request["expires_at"].replace("Z","+00:00"))
        current=__import__("datetime").datetime.now(__import__("datetime").timezone.utc)
        return request["device_id"]==device.id and issued <= current + timedelta(seconds=30) and expires > current and expires <= issued + timedelta(minutes=10)
    except Exception: return False  # noqa: BLE001 - untrusted channel credentials and attestations fail closed

@router.websocket("/agents/channel")
async def runtime_channel(websocket:WebSocket):
    authorization=websocket.headers.get("authorization")
    token=authorization.split(" ",1)[1] if authorization and authorization.lower().startswith("bearer ") else ""
    try:
        claims=decode_token(token); device_id=claims.get("device_id"); session_id=claims.get("sid")
        if claims.get("typ")!="access": raise ValueError("access token required")
        if not device_id or not session_id: raise ValueError("device session token required")
    except Exception:  # noqa: BLE001 - untrusted channel credentials and attestations fail closed
        await websocket.close(code=4401); return
    async with core_db.SessionLocal() as db:
        device=await db.get(Device,device_id); session=await db.get(AuthSession,session_id)
        if not session or session.revoked_at or session.owner_id!=claims.get("sub") or session.device_id not in {None,device_id}:
            await websocket.close(code=4401); return
        if not device or device.revoked_at or device.platform not in {"macos","helper"} or device.owner_id!=claims.get("sub"):
            await websocket.close(code=4403); return
        await websocket.accept(); await websocket.send_json({"type":"ready","device_id":device_id})
        try:
            while True:
                message=await websocket.receive_json(); kind=message.get("type")
                await db.refresh(device)
                await db.refresh(session)
                if device.revoked_at or session.revoked_at:
                    await websocket.close(code=4403); return
                if kind=="heartbeat":
                    device.last_seen_at=datetime.now(UTC); await db.commit(); await websocket.send_json({"type":"heartbeat_ack"})
                elif kind=="metadata_batch":
                    items=message.get("items",[])
                    if not isinstance(items,list) or any(set(item)-METADATA_FIELDS for item in items if isinstance(item,dict)):
                        await websocket.send_json({"type":"error","code":"VALIDATION_ERROR"}); continue
                    accepted=[]
                    for raw_item in items:
                        try: item=MetadataItem.model_validate(raw_item)
                        except ValidationError: await websocket.send_json({"type":"error","code":"VALIDATION_ERROR"}); continue
                        if item.device_id != device_id:
                            await websocket.send_json({"type":"error","code":"FORBIDDEN"}); continue
                        index_id=item.session_index_id
                        if not index_id: continue
                        project_id=item.project_id
                        if project_id:
                            project=await db.get(Project, project_id)
                            grant=await _active_project_grant(db, device.owner_id, project_id, device_id)
                            if not project or project.owner_id!=device.owner_id or not grant:
                                await websocket.send_json({"type":"error","code":"FORBIDDEN"}); continue
                        accepted.append(item)
                        existing=await db.get(AgentSessionIndex,index_id)
                        if existing and (existing.owner_id!=device.owner_id or existing.device_id!=device_id):
                            await websocket.send_json({"type":"error","code":"FORBIDDEN"}); continue
                        values={"owner_id":device.owner_id,"device_id":device_id,"project_id":project_id,"adapter":item.adapter,"opaque_local_session_ref":index_id,"state":item.state,"message_count":item.message_count,"started_at":item.started_at,"last_activity_at":item.last_activity_at}
                        if existing:
                            for key,value in values.items(): setattr(existing,key,value)
                        else: db.add(AgentSessionIndex(id=index_id,**values))
                    await db.commit(); await websocket.send_json({"type":"metadata_ack","count":len(accepted)})
                elif kind=="run_event":
                    run_id=message.get("run_id"); state=message.get("state"); lease_id=message.get("lease_id")
                    if state not in EVENT_STATES or not run_id: await websocket.send_json({"type":"error","code":"VALIDATION_ERROR"}); continue
                    run=(await db.execute(select(AgentRun).where(AgentRun.id==run_id).execution_options(populate_existing=True))).scalar_one_or_none()
                    if not run or run.owner_id!=device.owner_id or run.device_id!=device_id: await websocket.send_json({"type":"error","code":"FORBIDDEN"}); continue
                    grant=(await db.execute(select(ProjectGrant).where(ProjectGrant.owner_id==device.owner_id,ProjectGrant.project_id==run.project_id,ProjectGrant.device_id==device_id,ProjectGrant.policy_id==run.request_policy_id,ProjectGrant.revoked_at.is_(None),ProjectGrant.isolation_validated.is_(True)))).scalar_one_or_none()
                    if not grant:
                        await websocket.send_json({"type":"error","code":"POLICY_DENIED"}); continue
                    if run.status not in {"starting","running","waiting_approval"} or not run.lease_until or run.lease_until<=datetime.now(UTC) or not lease_id or lease_id!=run.lease_id:
                        await websocket.send_json({"type":"error","code":"LEASE_UNAVAILABLE"}); continue
                    if run.cancellation_requested and state != "cancelled":
                        await websocket.send_json({"type":"error","code":"CANCEL_REQUESTED"}); continue
                    if not _valid_run_transition(run.status, state):
                        await websocket.send_json({"type":"error","code":"INVALID_STATE"}); continue
                    run.status=state; run.error_code=message.get("error_code"); await db.commit(); await websocket.send_json({"type":"run_event_ack","run_id":run_id})
                elif kind in {"run_claim","run_heartbeat","run_cancel"}:
                    run_id=message.get("run_id")
                    run=(await db.execute(select(AgentRun).where(AgentRun.id==run_id).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
                    now_value=datetime.now(UTC); requested_lease_id=message.get("lease_id")
                    if not run or run.owner_id!=device.owner_id or run.device_id!=device_id: await websocket.send_json({"type":"error","code":"FORBIDDEN"}); continue
                    grant=(await db.execute(select(ProjectGrant).where(ProjectGrant.owner_id==device.owner_id,ProjectGrant.project_id==run.project_id,ProjectGrant.device_id==device_id,ProjectGrant.policy_id==run.request_policy_id,ProjectGrant.revoked_at.is_(None)))).scalar_one_or_none()
                    if not grant or not grant.isolation_validated:
                        await websocket.send_json({"type":"error","code":"POLICY_DENIED"}); continue
                    if kind=="run_claim":
                        if run.status=="queued": run.status="starting"; run.lease_id=str(__import__("uuid").uuid4()); run.lease_until=now_value+timedelta(minutes=5); await db.commit(); await websocket.send_json({"type":"run_claim_ack","run_id":run.id,"device_id":device.id,"status":run.status,"lease_id":run.lease_id,"lease_until":run.lease_until.isoformat(),"task":run.task})
                        elif run.status in {"starting","running"} and run.lease_until and run.lease_until>now_value: await websocket.send_json({"type":"run_claim_ack","run_id":run.id,"device_id":device.id,"status":run.status,"lease_id":run.lease_id,"lease_until":run.lease_until.isoformat(),"task":run.task})
                        else: await websocket.send_json({"type":"error","code":"LEASE_UNAVAILABLE"})
                    elif kind=="run_heartbeat":
                        if run.status not in {"starting","running"} or not run.lease_until or run.lease_until<=now_value or not requested_lease_id or requested_lease_id!=run.lease_id: await websocket.send_json({"type":"error","code":"LEASE_UNAVAILABLE"}); continue
                        run.lease_until=now_value+timedelta(minutes=5); await db.commit(); await websocket.send_json({"type":"run_heartbeat_ack","run_id":run.id,"lease_until":run.lease_until.isoformat(),"cancel_requested":run.cancellation_requested})
                    elif kind=="run_cancel":
                        if run.status not in {"starting","running","waiting_approval"} or not run.lease_until or run.lease_until<=now_value or not requested_lease_id or requested_lease_id!=run.lease_id: await websocket.send_json({"type":"error","code":"LEASE_UNAVAILABLE"}); continue
                        run.cancellation_requested=True; await db.commit(); await websocket.send_json({"type":"run_cancel_ack","run_id":run.id,"cancel_requested":True})
                elif kind=="credential_lease":
                    try:
                        request=CredentialLeaseIn(run_id=message.get("run_id",""),device_id=device.id,project_id=message.get("project_id",""),grant_id=message.get("grant_id",""),provider=message.get("provider",""))
                        lease=await _issue_credential_lease(request.run_id,request,device.owner_id,device,db)
                        await websocket.send_json({"type":"credential_lease_ack","lease":lease})
                    except ValidationError:
                        await websocket.send_json({"type":"error","code":"VALIDATION_ERROR"})
                    except HTTPException as exc:
                        detail=exc.detail if isinstance(exc.detail,dict) else {"code":"POLICY_DENIED"}
                        await websocket.send_json({"type":"error",**detail})
                elif kind=="isolation_attestation":
                    envelope=message.get("envelope",{}); request=envelope.get("request",{}); body=request.get("body",{}).get("payload",{})
                    grant=await db.get(ProjectGrant,body.get("grant_id"))
                    evidence=body.get("evidence",{})
                    expected_network_blocked=not bool(grant and grant.network_allowed)
                    checks={"grant":bool(grant and not grant.revoked_at and not grant.isolation_validated),"owner":bool(grant and grant.owner_id==device.owner_id),"device":bool(grant and grant.device_id==device.id),"project":bool(grant and grant.project_id==body.get("project_id")),"nonce":bool(grant and grant.isolation_nonce==body.get("nonce")),"probe_challenge":evidence.get("probe_challenge")==body.get("nonce"),"provenance":_verify_trusted_provenance(evidence) and isinstance(evidence.get("profile_digest"),str) and len(evidence.get("profile_digest"))==64,"signature":_verify_attestation(envelope,device),"evidence":all(evidence.get(k) is True for k in ("project_write","outside_read_blocked","credential_read_blocked","symlink_read_blocked","subprocess_escape_blocked")) and evidence.get("network_blocked") is expected_network_blocked}
                    valid=all(checks.values())
                    if not valid or grant is None: await websocket.send_json({"type":"error","code":"POLICY_DENIED","reason":"invalid isolation attestation"}); continue
                    grant.isolation_validated=True; grant.isolation_validated_at=now(); grant.isolation_nonce=None; db.add(AuditLog(owner_id=device.owner_id,action="project.grant.isolation_attest",actor=f"device:{device.id}",scope=f"grant:{grant.id}",decision="allow",outcome="validated",correlation_id=grant.id,redacted_metadata={"network_blocked":expected_network_blocked})); await db.commit(); await websocket.send_json({"type":"isolation_attestation_ack","grant_id":grant.id})
                else: await websocket.send_json({"type":"error","code":"UNKNOWN_MESSAGE"})
        except WebSocketDisconnect:
            return

@router.get("/agents/devices")
async def agent_devices(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(Device).where(Device.owner_id==user.id,Device.platform.in_(["macos","helper"]),Device.revoked_at.is_(None)))).scalars())
@router.get("/agents/sessions")
async def sessions(project_id:str|None=None,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,device=principal
    q=select(AgentSessionIndex).where(AgentSessionIndex.owner_id==user.id)
    if device:
        q=q.where(AgentSessionIndex.device_id==device.id)
    if project_id:
        if not device or not await _active_project_grant(db,user.id,project_id,device.id):
            raise HTTPException(403,detail={"code":"POLICY_DENIED","message":"Project grant required for agent metadata"})
        q=q.where(AgentSessionIndex.project_id==project_id)
    elif device:
        q=q.where(AgentSessionIndex.project_id.is_(None))
    return list((await db.execute(q)).scalars())
@router.post("/agents/sessions/search")
async def search_sessions(body:SessionSearch,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,device=principal
    if body.project_id and (not device or not await _active_project_grant(db,user.id,body.project_id,device.id)):
        raise HTTPException(403,detail={"code":"POLICY_DENIED","message":"Project grant required for agent search"})
    clauses=[AgentSessionIndex.owner_id==user.id]
    if device: clauses.append(AgentSessionIndex.device_id==device.id)
    clauses.append(AgentSessionIndex.project_id==body.project_id if body.project_id else AgentSessionIndex.project_id.is_(None))
    rows=list((await db.execute(select(AgentSessionIndex).where(*clauses).limit(body.limit))).scalars())
    # Search content is forwarded to the Mac runtime; cloud returns only safe metadata while no channel is connected.
    return {"status":"MAC_OFFLINE","results":[{"session_index_id":x.id,"project_id":x.project_id,"adapter":x.adapter,"state":x.state} for x in rows]}
@router.post("/agents/runs")
async def create_agent_run(body:RunIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; device=await db.get(Device,body.device_id); project=await db.get(Project,body.project_id)
    if not device or device.owner_id!=user.id or device.revoked_at: raise HTTPException(403,detail={"code":"DEVICE_REVOKED","message":"Mac device is not authorized"})
    if not project or project.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Project not found"})
    grant=(await db.execute(select(ProjectGrant).where(ProjectGrant.owner_id==user.id,ProjectGrant.project_id==body.project_id,ProjectGrant.device_id==body.device_id,ProjectGrant.policy_id==body.policy_id,ProjectGrant.revoked_at.is_(None)))).scalar_one_or_none()
    if not grant or not grant.isolation_validated: raise HTTPException(403,detail={"code":"POLICY_DENIED","message":"Remote autonomous execution is disabled until project isolation is validated"})
    existing=(await db.execute(select(AgentRun).where(AgentRun.owner_id==user.id,AgentRun.idempotency_key==body.idempotency_key))).scalar_one_or_none()
    if existing:
        if (existing.project_id, existing.device_id, existing.adapter, existing.request_policy_id, existing.task) != (body.project_id, body.device_id, body.adapter, body.policy_id, body.task):
            raise HTTPException(409,detail={"code":"IDEMPOTENCY_CONFLICT","message":"Idempotency key is bound to a different run"})
        return existing
    item=AgentRun(owner_id=user.id,project_id=body.project_id,device_id=body.device_id,adapter=body.adapter,status="queued",request_policy_id=body.policy_id,idempotency_key=body.idempotency_key,task=body.task,result_metadata_json={"task_length":len(body.task)})
    db.add(item)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing=(await db.execute(select(AgentRun).where(AgentRun.owner_id==user.id,AgentRun.idempotency_key==body.idempotency_key))).scalar_one_or_none()
        if existing:
            if (existing.project_id, existing.device_id, existing.adapter, existing.request_policy_id, existing.task) != (body.project_id, body.device_id, body.adapter, body.policy_id, body.task):
                raise HTTPException(409,detail={"code":"IDEMPOTENCY_CONFLICT","message":"Idempotency key is bound to a different run"})
            return existing
        raise
    await db.refresh(item); return item

@router.post("/agents/runs/{run_id}/credential-lease")
async def issue_credential_lease(run_id:str,body:CredentialLeaseIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,device=principal
    if not device:
        raise HTTPException(403,detail={"code":"FORBIDDEN","message":"Device-bound runtime credential required"})
    return await _issue_credential_lease(run_id,body,user.id,device,db)

@router.get("/agents/runs/{run_id}")
async def get_agent_run(run_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AgentRun,run_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Run not found"})
    return item
@router.get("/agents/runs/{run_id}/events", response_class=StreamingResponse, responses={200:{"content":{"text/event-stream":{}}}})
async def agent_run_events(run_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AgentRun,run_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Run not found"})
    async def stream():
        yield f"event: agent.run.status\ndata: {{\"run_id\":\"{run_id}\",\"status\":\"{item.status}\"}}\n\n"
    return StreamingResponse(stream(),media_type="text/event-stream")
@router.post("/agents/runs/{run_id}/cancel")
async def cancel_agent_run(run_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AgentRun,run_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Run not found"})
    if item.status=="queued": item.status="cancelled"
    elif item.status in {"starting","running","waiting_approval"}: item.cancellation_requested=True
    await db.commit()
    return item
