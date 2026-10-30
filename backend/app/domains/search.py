from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import JSON, String, Text, select
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


class ActivityEvent(OwnerScoped):
    __tablename__ = "activity_events"
    resource_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    event_kind: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    actor_kind: Mapped[str] = mapped_column(String(30), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(nullable=False)
    non_sensitive_metadata: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class Notification(OwnerScoped):
    __tablename__ = "notifications"
    kind: Mapped[str] = mapped_column(String(80), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(nullable=True)
    dedup_key: Mapped[str | None] = mapped_column(String(150), unique=True, nullable=True)
    data_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class HistoryEntry(OwnerScoped):
    __tablename__ = "history_entries"
    resource_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    actor: Mapped[str] = mapped_column(String(80), nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class SearchResult(APIModel):
    resource_type: str; resource_id: str; title: str; snippet: str | None = None; project_id: str | None = None
class NotificationOut(APIModel):
    id: str; owner_id: str; kind: str; title: str; body: str | None; read_at: datetime | None; data: dict[str, Any] = Field(validation_alias="data_json", serialization_alias="data"); created_at: datetime
class ActivityOut(APIModel):
    id: str; owner_id: str; resource_id: str | None; event_kind: str; actor_kind: str; actor_id: str | None; occurred_at: datetime; metadata: dict[str, Any] = Field(validation_alias="non_sensitive_metadata", serialization_alias="metadata")


class NotificationCreate(APIModel):
    kind: str = Field(min_length=1, max_length=80); title: str = Field(min_length=1, max_length=300); body: str | None = None; dedup_key: str | None = None; data: dict[str, Any] = Field(default_factory=dict)


class HistoryOut(APIModel):
    id: str; owner_id: str; resource_id: str | None; action: str; actor: str; metadata: dict[str, Any] = Field(validation_alias="metadata_json", serialization_alias="metadata"); created_at: datetime


router = APIRouter(prefix="/api/v1", tags=["search"])
@router.get("/search", response_model=list[SearchResult])
def search(q: str=Query(min_length=1), scope: str|None=None, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    # Search only server-authorized domain tables.  Local agent transcript search is a Mac-runtime call.
    like=f"%{q}%"; output=[]
    from .productivity import Note, Task
    for note in db.scalars(select(Note).where(Note.owner_id==owner_id,Note.deleted_at.is_(None), (Note.title.ilike(like)|Note.markdown_body.ilike(like)))): output.append(SearchResult(resource_type="note",resource_id=note.id,title=note.title,snippet=note.markdown_body[:300],project_id=note.project_id))
    for task in db.scalars(select(Task).where(Task.owner_id==owner_id,Task.deleted_at.is_(None), (Task.title.ilike(like)|Task.description.ilike(like)))): output.append(SearchResult(resource_type="task",resource_id=task.id,title=task.title,snippet=task.description,project_id=task.project_id))
    return output
@router.get("/notifications", response_model=list[NotificationOut])
def notifications(db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)): return list(db.scalars(select(Notification).where(Notification.owner_id==owner_id,Notification.deleted_at.is_(None)).order_by(Notification.created_at.desc())))


@router.post("/notifications", response_model=NotificationOut, status_code=201)
def create_notification(p: NotificationCreate, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    if p.dedup_key:
        previous=db.scalar(select(Notification).where(Notification.owner_id==owner_id,Notification.dedup_key==p.dedup_key))
        if previous: return previous
    return save(db,Notification(owner_id=owner_id,kind=p.kind,title=p.title,body=p.body,dedup_key=p.dedup_key,data_json=p.data))


@router.post("/notifications/{notification_id}/read", response_model=NotificationOut)
def mark_notification_read(notification_id: str, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    value=get_owned(db,Notification,notification_id,owner_id); value.read_at=now_utc(); value.version+=1; db.flush(); return value


@router.get("/history", response_model=list[HistoryOut])
def history(resource_id: str|None=None, db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)):
    q=select(HistoryEntry).where(HistoryEntry.owner_id==owner_id)
    if resource_id: q=q.where(HistoryEntry.resource_id==resource_id)
    return list(db.scalars(q.order_by(HistoryEntry.created_at.desc())))


def record_history(db: Session, owner_id: str, *, action: str, actor: str, resource_id: str|None=None, metadata: dict[str, Any]|None=None) -> HistoryEntry:
    """Record redacted metadata only; callers must never pass message bodies or secrets."""
    return save(db,HistoryEntry(owner_id=owner_id,resource_id=resource_id,action=action,actor=actor,metadata_json=metadata or {}))


@router.get("/activity", response_model=list[ActivityOut])
def activity(db: Session=Depends(db_dependency), owner_id: str=Depends(owner_dependency)): return list(db.scalars(select(ActivityEvent).where(ActivityEvent.owner_id==owner_id).order_by(ActivityEvent.occurred_at.desc())))
