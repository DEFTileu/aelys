from __future__ import annotations
import asyncio, json
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timezone
from typing import Any
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.db import get_db
from app.core.models import AIConversation, AIMessage, AIProvider, AIProviderSecret, AIRun, AIRunEvent, AuthSession, Note, Project, Task, uid
from app.core.security import bearer_scheme, current_principal, decode_token
from app.core.config import get_settings
from .crypto import decrypt_secret, encrypt_secret
from .execution import AIExecutionService, Adapter
from .errors import PolicyDenied, ToolValidationError
from .models import Capability, ChatMessage, ModelSpec, PermissionContext, PrivacyClass, ProviderKind, RoutingRequest, TaskKind, ToolCall
from .providers import ClaudeAdapter, HttpResponse, OpenRouterAdapter
from .secrets import AuthenticatedStreamCipher, SecretRef, SecretStore
from .policy import ServerPolicyEngine
from .tools import ToolDescriptor, ToolRegistry
from decimal import Decimal
import hashlib
import httpx
import ipaddress
from urllib.parse import urlparse

router=APIRouter()
_active_cancellations: dict[str, asyncio.Event] = {}
class ProviderIn(BaseModel): kind:str=Field(pattern="^(claude|openrouter)$"); base_url:str|None=None; enabled:bool=True; model_policy:dict={}; secret_ref:str|None=None
class ConversationIn(BaseModel): project_id:str|None=None; title:str="Conversation"; tool_scope:dict=Field(default_factory=dict)
class MessageIn(BaseModel): role:str=Field(pattern="^(user|assistant|system|tool)$"); content:str; source_refs:list[dict]=[]
class RunIn(BaseModel): conversation_id:str; message:str; routing:dict={}; tool_scope:dict={}; idempotency_key:str
class SecretIn(BaseModel): api_key:str=Field(min_length=8,max_length=4096)

class CreateTaskToolArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=10_000)
    project_id: str | None = Field(default=None, max_length=36)

class CreateNoteToolArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=300)
    markdown_body: str = Field(default="", max_length=100_000)
    project_id: str | None = Field(default=None, max_length=36)

# This is the server-registered, non-external AI policy. `tool_scope` is only a
# request for a subset of this set; it cannot introduce a new permission.
_REGISTERED_AI_TOOL_SCOPES = frozenset({"tasks.write", "notes.write"})

def _requested_tool_scopes(raw: Mapping[str, Any]) -> frozenset[str]:
    values = raw.get("scopes", [])
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise HTTPException(status_code=422, detail={"code":"VALIDATION_ERROR","message":"tool_scope.scopes must be a list of strings"})
    scopes = frozenset(values)
    if not scopes.issubset(_REGISTERED_AI_TOOL_SCOPES):
        raise HTTPException(status_code=403, detail={"code":"POLICY_DENIED","message":"Requested AI tool scope is not registered"})
    return scopes

def _tool_call(raw: Mapping[str, Any]) -> ToolCall:
    if "function" in raw and isinstance(raw["function"], Mapping):
        function = raw["function"]
        arguments = function.get("arguments", {})
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError as exc:
                raise ToolValidationError("tool arguments are invalid") from exc
        stable_id = str(raw.get("id") or hashlib.sha256(json.dumps({"name":function.get("name", ""),"arguments":arguments}, sort_keys=True, separators=(",",":"), default=str).encode()).hexdigest())
        return ToolCall(str(function.get("name", "")), arguments if isinstance(arguments, Mapping) else {}, stable_id)
    arguments = raw.get("input", raw.get("arguments", {}))
    stable_id = str(raw.get("id") or hashlib.sha256(json.dumps({"name":raw.get("name", ""),"arguments":arguments}, sort_keys=True, separators=(",",":"), default=str).encode()).hexdigest())
    return ToolCall(str(raw.get("name", "")), arguments if isinstance(arguments, Mapping) else {}, stable_id)

def _tool_registry(db: AsyncSession, owner_id: str, event_id: str) -> ToolRegistry:
    registry = ToolRegistry(ServerPolicyEngine())

    async def create_task(arguments: Mapping[str, Any]) -> Mapping[str, Any]:
        project_id = arguments.get("project_id")
        if project_id is not None and not await _owned_project(db, owner_id, str(project_id)):
            raise ValueError("project is outside the owner scope")
        item = Task(owner_id=owner_id, title=str(arguments["title"]), description=str(arguments.get("description", "")), project_id=str(project_id) if project_id is not None else None)
        db.add(item); await db.flush()
        return {"kind":"task", "id":item.id, "event_id":event_id}

    async def create_note(arguments: Mapping[str, Any]) -> Mapping[str, Any]:
        project_id = arguments.get("project_id")
        if project_id is not None and not await _owned_project(db, owner_id, str(project_id)):
            raise ValueError("project is outside the owner scope")
        item = Note(owner_id=owner_id, title=str(arguments["title"]), markdown_body=str(arguments.get("markdown_body", "")), project_id=str(project_id) if project_id is not None else None)
        db.add(item); await db.flush()
        return {"kind":"note", "id":item.id, "event_id":event_id}

    registry.register(ToolDescriptor("create_task", "Create an owner-scoped task", "tasks.write", lambda value: CreateTaskToolArgs.model_validate(value).model_dump(mode="json", exclude_none=True), create_task, input_schema=CreateTaskToolArgs.model_json_schema()))
    registry.register(ToolDescriptor("create_note", "Create an owner-scoped Markdown note", "notes.write", lambda value: CreateNoteToolArgs.model_validate(value).model_dump(mode="json", exclude_none=True), create_note, input_schema=CreateNoteToolArgs.model_json_schema()))
    return registry

async def _owned_project(db: AsyncSession, owner_id: str, project_id: str) -> Project | None:
    project = await db.get(Project, project_id)
    return project if project and project.owner_id == owner_id and project.deleted_at is None else None

async def _persist_event(db: AsyncSession, run_id: str, wire: str) -> str:
    event_type = next((line[7:] for line in wire.splitlines() if line.startswith("event: ")), "ai.run.event")
    raw_data = next((line[6:] for line in wire.splitlines() if line.startswith("data: ")), "{}")
    try:
        payload = json.loads(raw_data)
    except json.JSONDecodeError:
        payload = {"message": "redacted event payload unavailable"}
    sequence = int((await db.execute(select(func.max(AIRunEvent.sequence)).where(AIRunEvent.run_id == run_id))).scalar() or 0) + 1
    event_id = f"{run_id}:{sequence}"
    db.add(AIRunEvent(id=uid(), run_id=run_id, sequence=sequence, event_id=event_id, event_type=event_type, payload=payload))
    await db.flush()
    return f"id: {event_id}\n{wire}"

async def _replay_events(db: AsyncSession, run_id: str, last_event_id: str | None):
    after = 0
    if last_event_id and ":" in last_event_id:
        try:
            after = int(last_event_id.rsplit(":", 1)[1])
        except ValueError:
            after = 0
    return list((await db.execute(select(AIRunEvent).where(AIRunEvent.run_id == run_id, AIRunEvent.sequence > after).order_by(AIRunEvent.sequence))).scalars())

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

def _request_fingerprint(body: RunIn, effective_scope: frozenset[str]) -> str:
    canonical = json.dumps({"conversation_id":body.conversation_id,"message":body.message,"routing":body.routing,"tool_scope":{"scopes":sorted(effective_scope)}}, sort_keys=True, separators=(",",":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()

async def _remaining_monthly_budget(db: AsyncSession, owner_id: str, provider: AIProvider) -> Decimal:
    policy = provider.model_policy_json or {}
    try:
        monthly_budget = Decimal(str(policy.get("monthly_budget", "100")))
    except (ValueError, TypeError, ArithmeticError):
        return Decimal("0")
    if monthly_budget <= 0:
        return Decimal("0")
    now_utc = datetime.now(timezone.utc)
    month_start = now_utc.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    spent = (await db.execute(select(func.coalesce(func.sum(AIRun.cost_estimate), 0)).where(AIRun.owner_id == owner_id, AIRun.provider_id == provider.id, AIRun.status == "completed", AIRun.completed_at >= month_start))).scalar_one()
    return max(Decimal("0"), monthly_budget - Decimal(str(spent or "0")))

class HttpxTransport:
    def __init__(self, cancel_event: asyncio.Event | None = None, cancel_check: Callable[[], Awaitable[bool]] | None = None):
        self._cancel_event = cancel_event
        self._cancel_check = cancel_check

    async def post(self,url,*,headers,json):
        try:
            async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
                response=await client.post(url,headers=headers,json=json)
            try: body=response.json()
            except ValueError: body={}
            return HttpResponse(response.status_code,body)
        except httpx.HTTPError as exc:
            raise RuntimeError("provider transport unavailable") from exc
    async def stream(self,url,*,headers,json):
        try:
            async with httpx.AsyncClient(timeout=120, follow_redirects=False) as client:
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
@router.delete("/ai/providers/{provider_id}/secret")
async def delete_provider_secret(provider_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; provider=await db.get(AIProvider,provider_id)
    if not provider or provider.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Provider not found"})
    secret=await db.get(AIProviderSecret,provider_id)
    if secret: await db.delete(secret)
    provider.secret_ref=None
    await db.commit()
    return {"deleted":True,"provider_id":provider_id}
@router.post("/ai/conversations")
async def create_conversation(body:ConversationIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal
    if body.project_id:
        project = await db.get(Project, body.project_id)
        if not project or project.owner_id != user.id or project.deleted_at is not None:
            raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Conversation project not found"})
    scopes = _requested_tool_scopes(body.tool_scope)
    item=AIConversation(owner_id=user.id,project_id=body.project_id,title=body.title,tool_scope_json={"scopes":sorted(scopes)}); db.add(item); await db.commit(); await db.refresh(item); return item
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
    conversation_scopes = _requested_tool_scopes(convo.tool_scope_json or {})
    requested_scopes = _requested_tool_scopes(body.tool_scope)
    if requested_scopes and requested_scopes != conversation_scopes:
        raise HTTPException(status_code=403, detail={"code":"POLICY_DENIED","message":"AI run cannot change the conversation tool policy"})
    fingerprint = _request_fingerprint(body, conversation_scopes)
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
    item=AIRun(owner_id=user.id,conversation_id=body.conversation_id,prompt_message_id=message.id,provider_id=configured.id if configured else None,provider=provider,model=model,status="queued",idempotency_key=body.idempotency_key,request_fingerprint=fingerprint,tool_scope_json={"scopes":sorted(conversation_scopes)}); db.add(item)
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
async def run_events(run_id:str,principal=Depends(current_principal),credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AIRun,run_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Run not found"})
    claims = decode_token(credentials.credentials if credentials else "")
    session_id = str(claims.get("sid", ""))
    provider=await db.get(AIProvider, item.provider_id) if item.provider_id else (await db.execute(select(AIProvider).where(AIProvider.owner_id==user.id,AIProvider.kind==item.provider,AIProvider.enabled.is_(True),AIProvider.deleted_at.is_(None)))).scalars().first()
    secret=await db.get(AIProviderSecret,provider.id) if provider else None
    conversation = await db.get(AIConversation, item.conversation_id)
    last_message=await db.get(AIMessage, item.prompt_message_id) if item.prompt_message_id else None
    async def stream():
        async def emit(event_type: str, payload: Mapping[str, Any]) -> str:
            wire = f"event: {event_type}\ndata: {json.dumps(payload, separators=(',', ':'), ensure_ascii=False)}\n\n"
            result = await _persist_event(db, run_id, wire)
            await db.commit()
            return result

        history = await _replay_events(db, run_id, last_event_id)
        for event in history:
            yield f"id: {event.event_id}\nevent: {event.event_type}\ndata: {json.dumps(event.payload, separators=(',', ':'), ensure_ascii=False)}\n\n"
        if item.status in {"completed", "failed", "cancelled"}:
            if not history and not last_event_id:
                terminal_type = "ai.run.cancelled" if item.status == "cancelled" else "ai.run.completed" if item.status == "completed" else "ai.run.failed"
                yield await emit(terminal_type, {"run_id": run_id, "replayed": True})
            return
        if not provider or provider.owner_id != user.id or not provider.enabled or not secret or last_message is None:
            await db.execute(update(AIRun).where(AIRun.id==run_id,AIRun.owner_id==user.id,AIRun.status.in_(["queued","running"])).values(status="failed",completed_at=datetime.now(timezone.utc)))
            await db.commit()
            failure = f"event: ai.run.failed\ndata: {json.dumps({'run_id':run_id,'code':'MODEL_UNAVAILABLE' if provider and secret else 'PROMPT_UNAVAILABLE','message':'Provider, encrypted secret, or bound prompt is not available'})}\n\n"
            yield await _persist_event(db, run_id, failure)
            await db.commit()
            return
        try:
            await db.refresh(item)
            if item.status == "cancelled":
                yield await emit("ai.run.cancelled", {"run_id": run_id}); return
            started = await db.execute(
                update(AIRun)
                .where(AIRun.id == run_id, AIRun.owner_id == user.id, AIRun.status == "queued")
                .values(status="running", started_at=datetime.now(timezone.utc))
            )
            await db.commit()
            if int(getattr(started, "rowcount", 0) or 0) != 1:
                await db.refresh(item)
                if item.status == "cancelled":
                    yield await emit("ai.run.cancelled", {"run_id": run_id})
                elif item.status == "completed":
                    yield await emit("ai.run.completed", {"run_id": run_id, "replayed": True})
                elif item.status == "failed":
                    yield await emit("ai.run.failed", {"run_id": run_id, "code": "AI_ERROR", "message": "Provider execution failed", "replayed": True})
                else:
                    yield await emit("ai.run.in_progress", {"run_id": run_id})
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
            remaining_budget = await _remaining_monthly_budget(db, user.id, provider)
            if remaining_budget <= 0:
                await db.execute(update(AIRun).where(AIRun.id==run_id,AIRun.owner_id==user.id,AIRun.status=="running").values(status="failed",completed_at=datetime.now(timezone.utc)))
                await db.commit()
                yield await emit("ai.run.failed", {"run_id": run_id, "code": "BUDGET_EXCEEDED", "message": "Configured monthly AI budget is exhausted"})
                return
            request=RoutingRequest(TaskKind.UNKNOWN,privacy=PrivacyClass.PERSONAL,manual_model=requested_model,request_budget=min(Decimal("100"), remaining_budget))
            await db.refresh(item)
            requested_scopes = frozenset((item.tool_scope_json or {}).get("scopes", []))
            if requested_scopes:
                registry = _tool_registry(db, user.id, run_id)
                context = PermissionContext(actor=f"ai:{run_id}", scopes=requested_scopes, project_ids=frozenset({conversation.project_id}) if conversation and conversation.project_id else frozenset(), policy_id="ai")
                tool_request = RoutingRequest(TaskKind.TOOL_ACTION, required_capabilities=frozenset({Capability.TOOL_CALLING}), privacy=PrivacyClass.PERSONAL, manual_model=requested_model, request_budget=min(Decimal("100"), remaining_budget))
                result = await service.complete(__import__('uuid').UUID(run_id), tool_request, (ChatMessage("user",last_message.content if last_message else ""),), tools=tuple(registry.schemas()), cancel=cancel_event)
                if await durable_cancel_check():
                    yield await emit("ai.run.cancelled", {"run_id": run_id})
                    return
                yield await emit("ai.run.started", {"run_id": run_id, "provider": result.provider.value, "model": result.model})
                seen_calls: set[str] = set()
                for raw_call in result.response.tool_calls:
                    call = _tool_call(raw_call)
                    if call.call_id in seen_calls:
                        continue
                    seen_calls.add(call.call_id)
                    if await durable_cancel_check():
                        yield await emit("ai.run.cancelled", {"run_id": run_id})
                        return
                    yield await emit("ai.tool.requested", {"run_id": run_id, "tool": call.name, "call_id": call.call_id})
                    try:
                        output = await registry.invoke(call, context)
                    except (PolicyDenied, ToolValidationError, RuntimeError) as error:
                        await db.rollback()
                        await db.execute(update(AIRun).where(AIRun.id==run_id,AIRun.owner_id==user.id,AIRun.status=="running").values(status="failed",completed_at=datetime.now(timezone.utc)))
                        await db.commit()
                        code = "POLICY_DENIED" if isinstance(error, (PolicyDenied, ToolValidationError)) else "TOOL_ERROR"
                        message = "AI tool call was not authorized" if code == "POLICY_DENIED" else "AI tool execution failed"
                        yield await emit("ai.run.failed", {"run_id": run_id, "code": code, "message": message})
                        return
                    yield await emit("ai.tool.approved", {"run_id": run_id, "tool": call.name, "call_id": call.call_id})
                    yield await emit("ai.tool.result", {"run_id": run_id, "tool": call.name, "call_id": call.call_id, "result": output})
                if result.response.text:
                    yield await emit("ai.text.delta", {"run_id": run_id, "text": result.response.text})
                if cancel_event.is_set() or await durable_cancel_check():
                    yield await emit("ai.run.cancelled", {"run_id": run_id})
                    return
                item.token_counts={"input":result.usage.usage.input_tokens,"output":result.usage.usage.output_tokens}; item.cost_estimate=result.usage.estimated_cost
                await db.execute(update(AIRun).where(AIRun.id==run_id,AIRun.owner_id==user.id,AIRun.status=="running").values(status="completed",completed_at=datetime.now(timezone.utc),token_counts=item.token_counts,cost_estimate=item.cost_estimate)); await db.commit()
                yield await emit("ai.run.completed", {"run_id": run_id, "text_length": len(result.response.text), "estimated_cost": str(result.usage.estimated_cost)})
                return
            stream_failed = False
            async for event in service.stream_sse(__import__('uuid').UUID(run_id),request,(ChatMessage("user",last_message.content),),cancel=cancel_event,cancel_check=durable_cancel_check):
                await db.refresh(item)
                if item.status == "cancelled":
                    yield await emit("ai.run.cancelled", {"run_id": run_id})
                    return
                if event.startswith("event: ai.run.failed"):
                    stream_failed = True
                yield await _persist_event(db, run_id, event)
            if stream_failed:
                await db.execute(update(AIRun).where(AIRun.id==run_id,AIRun.owner_id==user.id,AIRun.status=="running").values(status="failed",completed_at=datetime.now(timezone.utc)))
                await db.commit()
                return
            if cancel_event.is_set() or await durable_cancel_check():
                yield await emit("ai.run.cancelled", {"run_id": run_id})
                return
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
                    yield await emit("ai.run.cancelled", {"run_id": run_id})
        except Exception:
            await db.refresh(item)
            if item.status == "cancelled":
                return
            failed=await db.execute(update(AIRun).where(AIRun.id==run_id,AIRun.owner_id==user.id,AIRun.status!="cancelled").values(status="failed",completed_at=datetime.now(timezone.utc)))
            await db.commit()
            if int(getattr(failed, "rowcount", 0) or 0) == 1:
                yield await emit("ai.run.failed", {"run_id": run_id, "code": "AI_ERROR", "message": "Provider execution failed"})
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
