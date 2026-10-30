from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from fastapi import APIRouter, Depends
from pydantic import Field
from sqlalchemy import String, Text, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .common import APIModel, OwnerScoped, db_dependency, owner_dependency, save


class MailAccount(OwnerScoped):
    __tablename__ = "mail_accounts"
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    external_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    credentials_ref: Mapped[str | None] = mapped_column(String(300), nullable=True)
    connection_status: Mapped[str] = mapped_column(String(30), default="local_import", nullable=False)


class MailMessage(OwnerScoped):
    __tablename__ = "mail_messages"
    account_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    provider_message_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    thread_id: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    sender: Mapped[str] = mapped_column(String(500), nullable=False)
    recipients: Mapped[list[str]] = mapped_column(__import__("sqlalchemy").JSON, default=list, nullable=False)
    subject: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    received_at: Mapped[datetime] = mapped_column(nullable=False)
    body_storage_ref: Mapped[str | None] = mapped_column(String(300), nullable=True)
    body_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    sync_origin: Mapped[str] = mapped_column(String(30), default="local_import", nullable=False)


class DraftStatus(StrEnum):
    draft = "draft"
    queued = "queued"
    sent = "sent"
    discarded = "discarded"


class MailDraft(OwnerScoped):
    __tablename__ = "mail_drafts"
    account_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    thread_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    recipients: Mapped[list[str]] = mapped_column(__import__("sqlalchemy").JSON, default=list, nullable=False)
    subject: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default=DraftStatus.draft.value, nullable=False)


class MailAccountCreate(APIModel): provider: str = "local_import"; external_id: str | None = None
class MessageImport(APIModel): account_id: str; sender: str; recipients: list[str] = Field(default_factory=list); subject: str = ""; received_at: datetime; body_text: str | None = None; body_storage_ref: str | None = None; provider_message_id: str | None = None; thread_id: str | None = None
class DraftCreate(APIModel): account_id: str; thread_id: str | None = None; recipients: list[str] = Field(default_factory=list); subject: str = ""; content: str = ""
class MailAccountOut(APIModel): id: str; owner_id: str; provider: str; external_id: str | None; connection_status: str
class MessageOut(APIModel): id: str; owner_id: str; account_id: str; provider_message_id: str | None; thread_id: str | None; sender: str; recipients: list[str]; subject: str; received_at: datetime; body_storage_ref: str | None; body_text: str | None; sync_origin: str
class DraftOut(APIModel): id: str; owner_id: str; account_id: str; thread_id: str | None; recipients: list[str]; subject: str; content: str; status: DraftStatus; version: int


router = APIRouter(prefix="/api/v1/mail", tags=["mail"])
@router.post("/accounts", response_model=MailAccountOut, status_code=201)
def create_account(p: MailAccountCreate, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)): return save(db,MailAccount(owner_id=owner_id,provider=p.provider,external_id=p.external_id))
@router.get("/accounts", response_model=list[MailAccountOut])
def list_accounts(db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)): return list(db.scalars(select(MailAccount).where(MailAccount.owner_id==owner_id,MailAccount.deleted_at.is_(None))))
@router.post("/messages", response_model=MessageOut, status_code=201)
def import_message(p: MessageImport, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)): return save(db,MailMessage(owner_id=owner_id,**p.model_dump()))
@router.get("/messages", response_model=list[MessageOut])
def list_messages(q: str|None=None, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    query=select(MailMessage).where(MailMessage.owner_id==owner_id,MailMessage.deleted_at.is_(None));
    if q: query=query.where((MailMessage.subject.ilike(f"%{q}%")) | (MailMessage.body_text.ilike(f"%{q}%")))
    return list(db.scalars(query.order_by(MailMessage.received_at.desc())))
@router.post("/drafts", response_model=DraftOut, status_code=201)
def create_draft(p: DraftCreate, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)): return save(db,MailDraft(owner_id=owner_id,**p.model_dump()))
@router.get("/drafts", response_model=list[DraftOut])
def list_drafts(db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)): return list(db.scalars(select(MailDraft).where(MailDraft.owner_id==owner_id,MailDraft.deleted_at.is_(None))))
