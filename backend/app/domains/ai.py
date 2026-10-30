"""AI settings and conversation contracts.

Provider calls are deliberately adapter based.  This module never stores a
provider secret, prompt transcript from the Mac session reader, or raw tool
arguments in an audit record.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Protocol

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import Field
from sqlalchemy import JSON, Numeric, String, Text, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .common import (
    APIModel,
    OwnerScoped,
    db_dependency,
    get_owned,
    now_utc,
    owner_dependency,
    save,
)


class ProviderKind(StrEnum):
    claude = "claude"
    openrouter = "openrouter"


class RunStatus(StrEnum):
    queued = "queued"
    running = "running"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class AIProvider(OwnerScoped):
    __tablename__ = "ai_providers"
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    enabled: Mapped[bool] = mapped_column(default=True, nullable=False)
    model_policy_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    secret_ref: Mapped[str | None] = mapped_column(String(300), nullable=True)


class AIConversation(OwnerScoped):
    __tablename__ = "ai_conversations"
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    title: Mapped[str | None] = mapped_column(String(300), nullable=True)


class AIMessage(OwnerScoped):
    __tablename__ = "ai_messages"
    conversation_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(30), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source_refs_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    safety_classification: Mapped[str] = mapped_column(String(40), default="normal", nullable=False)


class AIRun(OwnerScoped):
    __tablename__ = "ai_runs"
    conversation_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    model: Mapped[str] = mapped_column(String(150), nullable=False)
    status: Mapped[str] = mapped_column(String(30), default=RunStatus.queued.value, nullable=False)
    prompt_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    input_tokens: Mapped[int] = mapped_column(default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(default=0, nullable=False)
    cost_estimate: Mapped[Decimal] = mapped_column(Numeric(20, 8), default=Decimal(0), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)


class AIRunEvent(OwnerScoped):
    __tablename__ = "ai_run_events"
    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    sequence: Mapped[int] = mapped_column(nullable=False)
    event_type: Mapped[str] = mapped_column(String(60), nullable=False)
    data_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class ProviderCreate(APIModel):
    kind: ProviderKind; base_url: str | None = None; enabled: bool = True; model_policy: dict[str, Any] = Field(default_factory=dict); secret_ref: str | None = None
class ProviderOut(APIModel):
    id: str; owner_id: str; kind: ProviderKind; base_url: str | None; enabled: bool; model_policy: dict[str, Any] = Field(validation_alias="model_policy_json", serialization_alias="model_policy"); version: int
class ConversationCreate(APIModel): project_id: str | None = None; title: str | None = None
class ConversationOut(APIModel): id: str; owner_id: str; project_id: str | None; title: str | None; version: int; created_at: datetime
class MessageCreate(APIModel): role: str = Field(pattern="^(user|assistant|tool|system)$"); content: str = Field(min_length=1); source_refs: list[dict[str, Any]] = Field(default_factory=list); safety_classification: str = "normal"
class MessageOut(APIModel): id: str; owner_id: str; conversation_id: str; role: str; content: str; source_refs: list[dict[str, Any]] = Field(validation_alias="source_refs_json", serialization_alias="source_refs"); safety_classification: str; created_at: datetime
class RunCreate(APIModel): conversation_id: str; message: str = Field(min_length=1); provider: str | None = None; model: str | None = None; routing_mode: str = "auto"; project_ids: list[str] = Field(default_factory=list); idempotency_key: str | None = None
class RunOut(APIModel): id: str; owner_id: str; conversation_id: str; provider: str; model: str; status: RunStatus; input_tokens: int; output_tokens: int; cost_estimate: Decimal; started_at: datetime | None; completed_at: datetime | None; error_code: str | None


class SecretStore(Protocol):
    def put(self, owner_id: str, secret: str) -> str: ...
    def resolve(self, owner_id: str, secret_ref: str) -> str: ...
    def delete(self, owner_id: str, secret_ref: str) -> None: ...


class ProviderAdapter(Protocol):
    kind: ProviderKind
    async def stream(self, *, model: str, messages: list[dict[str, str]], api_key: str) -> AsyncIterator[str]: ...


class ModelRouter:
    def choose(self, providers: list[AIProvider], *, requested_provider: str | None, requested_model: str | None) -> tuple[str, str]:
        enabled=[p for p in providers if p.enabled]
        if requested_provider:
            enabled=[p for p in enabled if p.kind==requested_provider]
        if not enabled: raise ValueError("MODEL_UNAVAILABLE")
        provider=enabled[0]
        model=requested_model or provider.model_policy_json.get("default_model") or provider.model_policy_json.get("models", ["default"])[0]
        return provider.kind, model


router = APIRouter(prefix="/api/v1/ai", tags=["ai"])
@router.get("/providers", response_model=list[ProviderOut])
def list_providers(db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)): return list(db.scalars(select(AIProvider).where(AIProvider.owner_id==owner_id,AIProvider.deleted_at.is_(None))))
@router.post("/providers", response_model=ProviderOut, status_code=201)
def create_provider(p: ProviderCreate, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    # `secret_ref` is a reference only; callers must use a configured secret-store service to create it.
    return save(db,AIProvider(owner_id=owner_id,kind=p.kind.value,base_url=p.base_url,enabled=p.enabled,model_policy_json=p.model_policy,secret_ref=p.secret_ref))
@router.post("/conversations", response_model=ConversationOut, status_code=201)
def create_conversation(p: ConversationCreate, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)): return save(db,AIConversation(owner_id=owner_id,**p.model_dump()))
@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageOut])
def list_messages(conversation_id: str, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    get_owned(db,AIConversation,conversation_id,owner_id); return list(db.scalars(select(AIMessage).where(AIMessage.owner_id==owner_id,AIMessage.conversation_id==conversation_id).order_by(AIMessage.created_at)))
@router.post("/conversations/{conversation_id}/messages", response_model=MessageOut, status_code=201)
def add_message(conversation_id: str, p: MessageCreate, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    get_owned(db,AIConversation,conversation_id,owner_id); return save(db,AIMessage(owner_id=owner_id,conversation_id=conversation_id,**p.model_dump()))
@router.post("/runs", response_model=RunOut, status_code=201)
def create_run(p: RunCreate, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    get_owned(db,AIConversation,p.conversation_id,owner_id)
    if p.idempotency_key:
        previous=db.scalar(select(AIRun).where(AIRun.owner_id==owner_id,AIRun.idempotency_key==p.idempotency_key))
        if previous: return previous
    message=save(db,AIMessage(owner_id=owner_id,conversation_id=p.conversation_id,role="user",content=p.message))
    providers=list(db.scalars(select(AIProvider).where(AIProvider.owner_id==owner_id,AIProvider.deleted_at.is_(None))))
    provider,model=ModelRouter().choose(providers,requested_provider=p.provider,requested_model=p.model)
    run=save(db,AIRun(owner_id=owner_id,conversation_id=p.conversation_id,provider=provider,model=model,prompt_message_id=message.id,idempotency_key=p.idempotency_key))
    db.add_all([
        AIRunEvent(owner_id=owner_id,run_id=run.id,sequence=1,event_type="ai.run.started",data_json={"run_id":run.id}),
    ])
    return run
@router.get("/runs/{run_id}", response_model=RunOut)
def get_run(run_id: str, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)): return get_owned(db,AIRun,run_id,owner_id)
@router.post("/runs/{run_id}/cancel", response_model=RunOut)
def cancel_run(run_id: str, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    run=get_owned(db,AIRun,run_id,owner_id); run.status=RunStatus.cancelled.value; run.completed_at=now_utc(); run.version+=1; db.flush()
    db.add(AIRunEvent(owner_id=owner_id,run_id=run.id,sequence=2,event_type="ai.run.cancelled",data_json={"run_id":run.id}))
    return run


@router.get("/runs/{run_id}/events")
def run_events(run_id: str, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    get_owned(db,AIRun,run_id,owner_id)
    events=list(db.scalars(select(AIRunEvent).where(AIRunEvent.owner_id==owner_id,AIRunEvent.run_id==run_id).order_by(AIRunEvent.sequence)))
    def stream():
        for event in events:
            import json
            yield f"id: {event.sequence}\nevent: {event.event_type}\ndata: {json.dumps({'run_id': run_id, **event.data_json}, separators=(',', ':'))}\n\n"
    return StreamingResponse(stream(), media_type="text/event-stream")
