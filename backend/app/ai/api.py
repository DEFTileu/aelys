from __future__ import annotations
import asyncio, json
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.db import get_db
from app.core.models import AIConversation, AIMessage, AIProvider, AIProviderSecret, AIRun, AuthSession, Project
from app.core.security import bearer_scheme, current_principal, decode_token
from app.core.config import get_settings
from .crypto import decrypt_secret, encrypt_secret
from .execution import AIExecutionService, Adapter
from .models import Capability, ChatMessage, ModelSpec, PrivacyClass, ProviderKind, RoutingRequest, TaskKind
from .providers import ClaudeAdapter, HttpResponse, OpenRouterAdapter
from .secrets import AuthenticatedStreamCipher, SecretRef, SecretStore
from decimal import Decimal
import hashlib
import httpx
import ipaddress
from urllib.parse import urlparse

router=APIRouter()
_active_cancellations: dict[str, asyncio.Event] = {}
class ProviderIn(BaseModel): kind:str=Field(pattern="^(claude|openrouter)$"); base_url:str|None=None; enabled:bool=True; model_policy:dict={}; secret_ref:str|None=None
class ConversationIn(BaseModel): project_id:str|None=None; title:str="Conversation"
class MessageIn(BaseModel): role:str=Field(pattern="^(user|assistant|system|tool)$"); content:str; source_refs:list[dict]=[]
class RunIn(BaseModel): conversation_id:str; message:str; routing:dict={}; tool_scope:dict={}; idempotency_key:str
class SecretIn(BaseModel): api_key:str=Field(min_length=8,max_length=4096)

def _provider_base_url(kind: str, value: str | None) -> str:
    default = "https://api.anthropic.com" if kind == "claude" else "https://openrouter.ai"
    if value is None:
        return default
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower().rstrip(".")
    allowed = (kind == "claude" and host == "api.anthropic.com") or (kind == "openrouter" and host == "openrouter.ai")
    try:
        is_ip = ipaddress.ip_address(host)
    except ValueError:
        is_ip = None
    if parsed.scheme != "https" or not host or parsed.username or parsed.password or is_ip is not None or not allowed:
        raise HTTPException(status_code=422, detail={"code":"INVALID_PROVIDER_ENDPOINT","message":"Provider endpoint must be an approved HTTPS host"})
    return value.rstrip("/")

def _request_fingerprint(body: RunIn) -> str:
    canonical = json.dumps({"conversation_id":body.conversation_id,"message":body.message,"routing":body.routing,"tool_scope":body.tool_scope}, sort_keys=True, separators=(",",":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()

class HttpxTransport:
    def __init__(self, cancel_event: asyncio.Event | None = None, cancel_check: Callable[[], Awaitable[bool]] | None = None):
        self._cancel_event = cancel_event
        self._cancel_check = cancel_check

    async def post(self,url,*,headers,json):
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                response=await client.post(url,headers=headers,json=json)
            try: body=response.json()
            except ValueError: body={}
            return HttpResponse(response.status_code,body)
        except httpx.HTTPError as exc:
            raise RuntimeError("provider transport unavailable") from exc
    async def stream(self,url,*,headers,json):
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                async with client.stream("POST",url,headers=headers,json=json) as response:
                    if response.status_code>=400: raise RuntimeError(f"provider returned status {response.status_code}")
                    lines = response.aiter_lines().__aiter__()
                    while True:
                        async def read_line() -> str:
                            return await lines.__anext__()
                        next_line = asyncio.create_task(read_line())
                        cancellation = asyncio.create_task(self._cancel_event.wait()) if self._cancel_event else None
                        durable_cancellation = asyncio.create_task(self._wait_for_durable_cancellation()) if self._cancel_check else None
                        waiters: list[asyncio.Task[Any]] = [next_line]
                        if cancellation:
                            waiters.append(cancellation)
                        if durable_cancellation:
                            waiters.append(durable_cancellation)
                        done, pending = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
                        if cancellation in done or durable_cancellation in done:
                            next_line.cancel()
                            await asyncio.gather(next_line, *pending, return_exceptions=True)
                            return
                        for task in pending:
                            task.cancel()
                        await asyncio.gather(*pending, return_exceptions=True)
                        try:
                            line = await next_line
                        except StopAsyncIteration:
                            break
                        if not line.startswith("data:"): continue
                        value=line[5:].strip()
                        if value=="[DONE]": break
                        try: yield json_loads(value)
                        except ValueError: continue
        except httpx.HTTPError as exc:
            raise RuntimeError("provider transport unavailable") from exc

    async def _wait_for_durable_cancellation(self):
        while True:
            if self._cancel_check and await self._cancel_check():
                if self._cancel_event:
                    self._cancel_event.set()
                return
            await asyncio.sleep(0.25)

def json_loads(value):
    import json
    return json.loads(value)

def _service(provider: AIProvider, secret_value: str, *, cancel_event: asyncio.Event | None = None, cancel_check: Callable[[], Awaitable[bool]] | None = None) -> AIExecutionService:
    settings=get_settings(); master=hashlib.sha256(settings.secret_key.encode()).digest()
    store=SecretStore(AuthenticatedStreamCipher(master)); ref=SecretRef(provider.kind,provider.secret_ref or provider.id); store.put(ref,secret_value)
    transport = HttpxTransport(cancel_event=cancel_event, cancel_check=cancel_check)
    endpoint = _provider_base_url(provider.kind, provider.base_url)
    adapter=ClaudeAdapter(transport,store,ref,endpoint) if provider.kind=="claude" else OpenRouterAdapter(transport,store,ref,endpoint)
    policy=provider.model_policy_json or {}; raw_models=policy.get("models") or [{"name":policy.get("default_model","default"),"capabilities":["streaming"],"context_tokens":100000,"input_cost_per_1k":"0","output_cost_per_1k":"0"}]
    specs=[]
    for raw in raw_models:
        specs.append(ModelSpec(ProviderKind(provider.kind),raw["name"],frozenset(Capability(x) for x in raw.get("capabilities",["streaming"])),int(raw.get("context_tokens",100000)),Decimal(str(raw.get("input_cost_per_1k","0"))),Decimal(str(raw.get("output_cost_per_1k","0"))),privacy_classes=frozenset(PrivacyClass(x) for x in raw.get("privacy_classes",["personal"]))))
    adapters: dict[ProviderKind, Adapter] = {ProviderKind(provider.kind): adapter}
    return AIExecutionService(specs,adapters)

@router.get("/ai/providers")
async def providers(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; rows=(await db.execute(select(AIProvider).where(AIProvider.owner_id==user.id,AIProvider.deleted_at.is_(None)))).scalars()
    return [{"id":x.id,"kind":x.kind,"base_url":x.base_url,"enabled":x.enabled,"model_policy":x.model_policy_json,"secret_ref":x.secret_ref} for x in rows]
@router.post("/ai/providers")
async def create_provider(body:ProviderIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; endpoint = None if body.base_url is None else _provider_base_url(body.kind, body.base_url); item=AIProvider(owner_id=user.id,kind=body.kind,base_url=endpoint,enabled=body.enabled,model_policy_json=body.model_policy,secret_ref=body.secret_ref); db.add(item); await db.commit(); await db.refresh(item); return {"id":item.id,"kind":item.kind,"enabled":item.enabled}
@router.put("/ai/providers/{provider_id}/secret")
async def set_provider_secret(provider_id:str,body:SecretIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; provider=await db.get(AIProvider,provider_id)
    if not provider or provider.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Provider not found"})
    existing=await db.get(AIProviderSecret,provider_id)
    if existing: existing.encrypted_value=encrypt_secret(body.api_key)
    else: db.add(AIProviderSecret(provider_id=provider_id,owner_id=user.id,encrypted_value=encrypt_secret(body.api_key)))
    if not provider.secret_ref: provider.secret_ref=provider_id
    await db.commit()
    return {"stored":True,"provider_id":provider_id,"last_four":body.api_key[-4:]}
@router.post("/ai/conversations")
async def create_conversation(body:ConversationIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal
    if body.project_id:
        project = await db.get(Project, body.project_id)
        if not project or project.owner_id != user.id or project.deleted_at is not None:
            raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Conversation project not found"})
    item=AIConversation(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/ai/conversations/{conversation_id}/messages")
async def messages(conversation_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; convo=await db.get(AIConversation,conversation_id)
    if not convo or convo.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Conversation not found"})
    return list((await db.execute(select(AIMessage).where(AIMessage.conversation_id==conversation_id).order_by(AIMessage.created_at))).scalars())
@router.post("/ai/conversations/{conversation_id}/messages")
async def add_message(conversation_id:str,body:MessageIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; convo=await db.get(AIConversation,conversation_id)
    if not convo or convo.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Conversation not found"})
    item=AIMessage(conversation_id=conversation_id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.post("/ai/runs")
async def create_run(body:RunIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; convo=await db.get(AIConversation,body.conversation_id)
    if not convo or convo.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Conversation not found"})
    fingerprint = _request_fingerprint(body)
    existing=(await db.execute(select(AIRun).where(AIRun.owner_id==user.id,AIRun.idempotency_key==body.idempotency_key))).scalar_one_or_none()
    if existing:
        if existing.request_fingerprint != fingerprint:
            raise HTTPException(409,detail={"code":"IDEMPOTENCY_CONFLICT","message":"Idempotency key is bound to a different AI request"})
        return existing
    requested_provider=body.routing.get("provider")
    configured=(await db.execute(select(AIProvider).where(AIProvider.owner_id==user.id,AIProvider.enabled.is_(True),AIProvider.deleted_at.is_(None), *( [AIProvider.kind==requested_provider] if requested_provider else [] )).order_by(AIProvider.created_at))).scalars().first()
    provider=configured.kind if configured else "configured"; model=body.routing.get("model","auto")
    message = AIMessage(conversation_id=body.conversation_id,role="user",content=body.message)
    db.add(message); await db.flush()
    item=AIRun(owner_id=user.id,conversation_id=body.conversation_id,prompt_message_id=message.id,provider=provider,model=model,status="queued",idempotency_key=body.idempotency_key,request_fingerprint=fingerprint); db.add(item)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = (await db.execute(select(AIRun).where(AIRun.owner_id==user.id,AIRun.idempotency_key==body.idempotency_key))).scalar_one_or_none()
        if not existing or existing.request_fingerprint != fingerprint:
            raise HTTPException(409,detail={"code":"IDEMPOTENCY_CONFLICT","message":"Idempotency key is bound to a different AI request"}) from None
        return existing
    await db.refresh(item); return item
@router.get("/ai/runs/{run_id}")
async def get_run(run_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AIRun,run_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Run not found"})
    return item
@router.get("/ai/runs/{run_id}/events", response_class=StreamingResponse, responses={200:{"content":{"text/event-stream":{}}}})
async def run_events(run_id:str,principal=Depends(current_principal),credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AIRun,run_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Run not found"})
    claims = decode_token(credentials.credentials if credentials else "")
    session_id = str(claims.get("sid", ""))
    provider=(await db.execute(select(AIProvider).where(AIProvider.owner_id==user.id,AIProvider.kind==item.provider,AIProvider.enabled.is_(True),AIProvider.deleted_at.is_(None)))).scalar_one_or_none()
    secret=await db.get(AIProviderSecret,provider.id) if provider else None
    last_message=await db.get(AIMessage, item.prompt_message_id) if item.prompt_message_id else None
    if last_message is None:
        last_message=(await db.execute(select(AIMessage).where(AIMessage.conversation_id==item.conversation_id,AIMessage.role=="user").order_by(AIMessage.created_at.desc()).limit(1))).scalars().first()
    async def stream():
        if not provider or not secret:
            yield f"event: ai.run.failed\ndata: {json.dumps({'run_id':run_id,'code':'MODEL_UNAVAILABLE','message':'Provider or encrypted BYOK secret is not configured'})}\n\n"; return
        try:
            await db.refresh(item)
            if item.status == "cancelled":
                yield f"event: ai.run.cancelled\ndata: {json.dumps({'run_id':run_id})}\n\n"; return
            started = await db.execute(
                update(AIRun)
                .where(AIRun.id == run_id, AIRun.owner_id == user.id, AIRun.status == "queued")
                .values(status="running", started_at=datetime.now(timezone.utc))
            )
            await db.commit()
            if int(getattr(started, "rowcount", 0) or 0) != 1:
                await db.refresh(item)
                if item.status == "cancelled":
                    yield f"event: ai.run.cancelled\ndata: {json.dumps({'run_id':run_id})}\n\n"
                elif item.status == "completed":
                    yield f"event: ai.run.completed\ndata: {json.dumps({'run_id':run_id,'replayed':True})}\n\n"
                elif item.status == "failed":
                    yield f"event: ai.run.failed\ndata: {json.dumps({'run_id':run_id,'code':'AI_ERROR','message':'Provider execution failed','replayed':True})}\n\n"
                else:
                    yield f"event: ai.run.in_progress\ndata: {json.dumps({'run_id':run_id})}\n\n"
                return
            cancel_event=asyncio.Event(); _active_cancellations[run_id]=cancel_event
            async def durable_cancel_check() -> bool:
                current=(await db.execute(select(AIRun.status).where(AIRun.id==run_id,AIRun.owner_id==user.id))).scalar_one_or_none()
                session = await db.get(AuthSession, session_id)
                session_revoked = not session or session.owner_id != user.id or session.revoked_at is not None
                cancelled=current=="cancelled" or session_revoked
                if session_revoked and current in {"queued", "running", "starting"}:
                    await db.execute(update(AIRun).where(AIRun.id==run_id,AIRun.owner_id==user.id,AIRun.status.in_(["queued", "running", "starting"])).values(status="cancelled",completed_at=datetime.now(timezone.utc)))
                    await db.commit()
                if cancelled: cancel_event.set()
                return cancelled
            service=_service(provider,decrypt_secret(secret.encrypted_value),cancel_event=cancel_event,cancel_check=durable_cancel_check); requested_model=item.model if item.model!="auto" else None
            request=RoutingRequest(TaskKind.UNKNOWN,privacy=PrivacyClass.PERSONAL,manual_model=requested_model,request_budget=Decimal("100"))
            await db.refresh(item)
            async for event in service.stream_sse(__import__('uuid').UUID(run_id),request,(ChatMessage("user",last_message.content if last_message else ""),),cancel=cancel_event,cancel_check=durable_cancel_check):
                await db.refresh(item)
                if item.status == "cancelled":
                    yield f"event: ai.run.cancelled\ndata: {json.dumps({'run_id':run_id})}\n\n"
                    return
                yield event
            await db.refresh(item)
            if item.status == "cancelled":
                return
            usage=service.usage.records()[-1] if service.usage.records() else None
            if usage:
                item.token_counts={"input":usage.usage.input_tokens,"output":usage.usage.output_tokens}
                item.cost_estimate=usage.estimated_cost
            completed=await db.execute(update(AIRun).where(AIRun.id==run_id,AIRun.owner_id==user.id,AIRun.status=="running").values(status="completed",completed_at=datetime.now(timezone.utc),token_counts=item.token_counts,cost_estimate=item.cost_estimate))
            await db.commit()
            if int(getattr(completed, "rowcount", 0) or 0) != 1:
                await db.refresh(item)
                if item.status == "cancelled":
                    yield f"event: ai.run.cancelled\ndata: {json.dumps({'run_id':run_id})}\n\n"
        except Exception:
            await db.refresh(item)
            if item.status == "cancelled":
                return
            failed=await db.execute(update(AIRun).where(AIRun.id==run_id,AIRun.owner_id==user.id,AIRun.status!="cancelled").values(status="failed",completed_at=datetime.now(timezone.utc)))
            await db.commit()
            if int(getattr(failed, "rowcount", 0) or 0) == 1:
                yield f"event: ai.run.failed\ndata: {json.dumps({'run_id':run_id,'code':'AI_ERROR','message':'Provider execution failed'})}\n\n"
        finally:
            _active_cancellations.pop(run_id,None)
    return StreamingResponse(stream(),media_type="text/event-stream")
@router.post("/ai/runs/{run_id}/cancel")
async def cancel_run(run_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AIRun,run_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Run not found"})
    active=_active_cancellations.get(run_id)
    if active: active.set()
    if item.status in {"queued","running","starting"}:
        await db.execute(update(AIRun).where(AIRun.id==run_id,AIRun.owner_id==user.id,AIRun.status.in_(["queued","running","starting"])).values(status="cancelled",completed_at=datetime.now(timezone.utc)))
        await db.commit()
        await db.refresh(item)
    return item
