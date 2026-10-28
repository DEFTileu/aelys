"""Notes, tasks, calendar and focus domain APIs."""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import Field, model_validator
from sqlalchemy import JSON, String, Text, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .common import APIModel, Base, OwnerScoped, ConflictError, db_dependency, get_owned, now_utc, owner_dependency, save, soft_delete, update_version


class Note(OwnerScoped):
    __tablename__ = "notes"
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    markdown_body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    tags_json: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)


class NoteRevision(Base):
    __tablename__ = "note_revisions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: __import__("uuid").uuid4().__str__())
    owner_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    note_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    base_version: Mapped[int] = mapped_column(nullable=False)
    revision_no: Mapped[int] = mapped_column(nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    source_device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=now_utc, nullable=False)


class TaskStatus(StrEnum):
    inbox = "inbox"
    planned = "planned"
    in_progress = "in_progress"
    done = "done"
    cancelled = "cancelled"


class TaskPriority(StrEnum):
    low = "low"
    normal = "normal"
    high = "high"
    urgent = "urgent"


class Task(OwnerScoped):
    __tablename__ = "tasks"
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(30), default=TaskStatus.inbox.value, nullable=False, index=True)
    priority: Mapped[str] = mapped_column(String(20), default=TaskPriority.normal.value, nullable=False)
    due_at: Mapped[datetime | None] = mapped_column(nullable=True, index=True)
    due_timezone: Mapped[str | None] = mapped_column(String(80), nullable=True)
    rrule: Mapped[str | None] = mapped_column(String(500), nullable=True)
    parent_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    tags_json: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)


class TaskReminder(OwnerScoped):
    __tablename__ = "task_reminders"
    task_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    notify_at: Mapped[datetime] = mapped_column(nullable=False)
    channel: Mapped[str] = mapped_column(String(30), default="in_app", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)


class CalendarEvent(OwnerScoped):
    __tablename__ = "calendar_events"
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    starts_at: Mapped[datetime] = mapped_column(nullable=False, index=True)
    ends_at: Mapped[datetime] = mapped_column(nullable=False)
    timezone: Mapped[str] = mapped_column(String(80), default="UTC", nullable=False)
    all_day: Mapped[bool] = mapped_column(default=False, nullable=False)
    rrule: Mapped[str | None] = mapped_column(String(500), nullable=True)
    recurrence_exceptions: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    linked_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)


class FocusMode(StrEnum):
    pomodoro = "pomodoro"
    stopwatch = "stopwatch"
    custom = "custom"


class FocusSession(OwnerScoped):
    __tablename__ = "focus_sessions"
    task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    started_at: Mapped[datetime] = mapped_column(nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(nullable=True)
    elapsed_seconds: Mapped[int] = mapped_column(default=0, nullable=False)
    mode: Mapped[str] = mapped_column(String(20), default=FocusMode.pomodoro.value, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False, index=True)
    device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


class NoteCreate(APIModel):
    title: str = Field(min_length=1, max_length=300)
    markdown_body: str = ""
    parent_id: str | None = None
    project_id: str | None = None
    tags: list[str] = Field(default_factory=list)


class NotePatch(APIModel):
    version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    markdown_body: str | None = None
    parent_id: str | None = None
    project_id: str | None = None
    tags: list[str] | None = None


class NoteOut(APIModel):
    id: str; owner_id: str; title: str; markdown_body: str; parent_id: str | None; project_id: str | None; tags: list[str] = Field(validation_alias="tags_json", serialization_alias="tags"); version: int; created_at: datetime; updated_at: datetime


class TaskCreate(APIModel):
    title: str = Field(min_length=1, max_length=300)
    description: str | None = None
    status: TaskStatus = TaskStatus.inbox
    priority: TaskPriority = TaskPriority.normal
    due_at: datetime | None = None
    due_timezone: str | None = None
    rrule: str | None = None
    parent_task_id: str | None = None
    project_id: str | None = None
    tags: list[str] = Field(default_factory=list)


class TaskPatch(APIModel):
    version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None; status: TaskStatus | None = None; priority: TaskPriority | None = None
    due_at: datetime | None = None; due_timezone: str | None = None; rrule: str | None = None; parent_task_id: str | None = None; project_id: str | None = None; tags: list[str] | None = None


class TaskOut(APIModel):
    id: str; owner_id: str; title: str; description: str | None; status: TaskStatus; priority: TaskPriority; due_at: datetime | None; due_timezone: str | None; rrule: str | None; parent_task_id: str | None; project_id: str | None; tags: list[str] = Field(validation_alias="tags_json", serialization_alias="tags"); version: int; created_at: datetime; updated_at: datetime


class EventCreate(APIModel):
    title: str = Field(min_length=1, max_length=300); description: str | None = None; starts_at: datetime; ends_at: datetime; timezone: str = "UTC"; all_day: bool = False; rrule: str | None = None; recurrence_exceptions: list[str] = Field(default_factory=list); linked_task_id: str | None = None; project_id: str | None = None
    @model_validator(mode="after")
    def ordered(self):
        if self.ends_at < self.starts_at: raise ValueError("ends_at must be after starts_at")
        return self


class EventOut(APIModel):
    id: str; owner_id: str; title: str; description: str | None; starts_at: datetime; ends_at: datetime; timezone: str; all_day: bool; rrule: str | None; recurrence_exceptions: list[str]; linked_task_id: str | None; project_id: str | None; version: int; created_at: datetime; updated_at: datetime


class EventPatch(APIModel):
    version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None; starts_at: datetime | None = None; ends_at: datetime | None = None
    timezone: str | None = None; all_day: bool | None = None; rrule: str | None = None
    recurrence_exceptions: list[str] | None = None; linked_task_id: str | None = None; project_id: str | None = None


class ReminderCreate(APIModel):
    task_id: str; notify_at: datetime; channel: str = "in_app"; idempotency_key: str = Field(min_length=1, max_length=100)


class ReminderOut(APIModel):
    id: str; owner_id: str; task_id: str; notify_at: datetime; channel: str; status: str; idempotency_key: str


class FocusCreate(APIModel):
    started_at: datetime | None = None; task_id: str | None = None; project_id: str | None = None; mode: FocusMode = FocusMode.pomodoro; device_id: str | None = None


class FocusOut(APIModel):
    id: str; owner_id: str; task_id: str | None; project_id: str | None; started_at: datetime; ended_at: datetime | None; elapsed_seconds: int; mode: FocusMode; status: str; device_id: str | None; version: int


def _patch(value: Any, owner_id: str, payload: Any, db: Session, fields: dict[str, Any]):
    get_owned(db, type(value), value.id, owner_id); update_version(value, payload.version, fields); db.flush(); return value


router = APIRouter(prefix="/api/v1", tags=["productivity"])


@router.post("/notes", response_model=NoteOut, status_code=201)
def create_note(p: NoteCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return save(db, Note(owner_id=owner_id, title=p.title, markdown_body=p.markdown_body, parent_id=p.parent_id, project_id=p.project_id, tags_json=p.tags))


@router.get("/notes", response_model=list[NoteOut])
def list_notes(project_id: str | None = None, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    q = select(Note).where(Note.owner_id == owner_id, Note.deleted_at.is_(None)); q = q.where(Note.project_id == project_id) if project_id else q
    return list(db.scalars(q.order_by(Note.updated_at.desc())))


@router.get("/notes/{note_id}", response_model=NoteOut)
def get_note(note_id: str, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return get_owned(db, Note, note_id, owner_id)


@router.patch("/notes/{note_id}", response_model=NoteOut)
def patch_note(note_id: str, p: NotePatch, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    n=get_owned(db, Note, note_id, owner_id); result=_patch(n, owner_id, p, db, {"title":p.title,"markdown_body":p.markdown_body,"parent_id":p.parent_id,"project_id":p.project_id,"tags_json":p.tags})
    db.add(NoteRevision(owner_id=owner_id,note_id=n.id,base_version=p.version,revision_no=n.version,body=n.markdown_body)); return result


@router.delete("/notes/{note_id}", response_model=NoteOut)
def delete_note(note_id: str, version: int | None = None, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return soft_delete(db, get_owned(db, Note, note_id, owner_id), version)


@router.get("/notes/{note_id}/revisions")
def note_revisions(note_id: str, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    get_owned(db, Note, note_id, owner_id); return list(db.scalars(select(NoteRevision).where(NoteRevision.owner_id==owner_id,NoteRevision.note_id==note_id).order_by(NoteRevision.revision_no.desc())))


@router.post("/tasks", response_model=TaskOut, status_code=201)
def create_task(p: TaskCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return save(db, Task(owner_id=owner_id,title=p.title,description=p.description,status=p.status.value,priority=p.priority.value,due_at=p.due_at,due_timezone=p.due_timezone,rrule=p.rrule,parent_task_id=p.parent_task_id,project_id=p.project_id,tags_json=p.tags))


@router.get("/tasks", response_model=list[TaskOut])
def list_tasks(project_id: str | None = None, status: TaskStatus | None = None, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    q=select(Task).where(Task.owner_id==owner_id,Task.deleted_at.is_(None)); q=q.where(Task.project_id==project_id) if project_id else q; q=q.where(Task.status==status.value) if status else q; return list(db.scalars(q.order_by(Task.due_at.asc().nullslast(),Task.updated_at.desc())))


@router.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(task_id: str, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return get_owned(db, Task, task_id, owner_id)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
def patch_task(task_id: str, p: TaskPatch, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    t=get_owned(db,Task,task_id,owner_id); return _patch(t,owner_id,p,db,{"title":p.title,"description":p.description,"status":p.status.value if p.status else None,"priority":p.priority.value if p.priority else None,"due_at":p.due_at,"due_timezone":p.due_timezone,"rrule":p.rrule,"parent_task_id":p.parent_task_id,"project_id":p.project_id,"tags_json":p.tags})


@router.delete("/tasks/{task_id}", response_model=TaskOut)
def delete_task(task_id: str, version: int | None = None, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return soft_delete(db,get_owned(db,Task,task_id,owner_id),version)


@router.post("/calendar/events", response_model=EventOut, status_code=201)
def create_event(p: EventCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return save(db,CalendarEvent(owner_id=owner_id,**p.model_dump()))


@router.get("/calendar/events", response_model=list[EventOut])
def list_events(starts_after: datetime | None = None, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    q=select(CalendarEvent).where(CalendarEvent.owner_id==owner_id,CalendarEvent.deleted_at.is_(None)); q=q.where(CalendarEvent.starts_at>=starts_after) if starts_after else q; return list(db.scalars(q.order_by(CalendarEvent.starts_at)))


@router.get("/calendar/events/{event_id}", response_model=EventOut)
def get_event(event_id: str, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return get_owned(db,CalendarEvent,event_id,owner_id)


@router.patch("/calendar/events/{event_id}", response_model=EventOut)
def patch_event(event_id: str, p: EventPatch, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    event=get_owned(db,CalendarEvent,event_id,owner_id)
    starts=p.starts_at if p.starts_at is not None else event.starts_at
    ends=p.ends_at if p.ends_at is not None else event.ends_at
    if ends < starts: raise ValueError("ends_at must be after starts_at")
    return _patch(event,owner_id,p,db,{"title":p.title,"description":p.description,"starts_at":p.starts_at,"ends_at":p.ends_at,"timezone":p.timezone,"all_day":p.all_day,"rrule":p.rrule,"recurrence_exceptions":p.recurrence_exceptions,"linked_task_id":p.linked_task_id,"project_id":p.project_id})


@router.delete("/calendar/events/{event_id}", response_model=EventOut)
def delete_event(event_id: str, version: int | None = None, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return soft_delete(db,get_owned(db,CalendarEvent,event_id,owner_id),version)


@router.post("/tasks/{task_id}/reminders", response_model=ReminderOut, status_code=201)
def create_reminder(task_id: str, p: ReminderCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    get_owned(db,Task,task_id,owner_id)
    if p.task_id != task_id: raise ValueError("task_id does not match path")
    existing=db.scalar(select(TaskReminder).where(TaskReminder.owner_id==owner_id,TaskReminder.idempotency_key==p.idempotency_key))
    if existing: return existing
    return save(db,TaskReminder(owner_id=owner_id,**p.model_dump()))


@router.get("/tasks/{task_id}/reminders", response_model=list[ReminderOut])
def list_reminders(task_id: str, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    get_owned(db,Task,task_id,owner_id)
    return list(db.scalars(select(TaskReminder).where(TaskReminder.owner_id==owner_id,TaskReminder.task_id==task_id).order_by(TaskReminder.notify_at)))


@router.post("/focus/sessions", response_model=FocusOut, status_code=201)
def start_focus(p: FocusCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    active=db.scalar(select(FocusSession).where(FocusSession.owner_id==owner_id,FocusSession.status=="active"))
    if active: raise ConflictError("An active focus session already exists",details={"session_id":active.id})
    return save(db,FocusSession(owner_id=owner_id,started_at=p.started_at or now_utc(),task_id=p.task_id,project_id=p.project_id,mode=p.mode.value,device_id=p.device_id))


@router.get("/focus/sessions", response_model=list[FocusOut])
def list_focus(db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)): return list(db.scalars(select(FocusSession).where(FocusSession.owner_id==owner_id).order_by(FocusSession.started_at.desc())))


@router.post("/focus/sessions/{session_id}/stop", response_model=FocusOut)
def stop_focus(session_id: str, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    s=get_owned(db,FocusSession,session_id,owner_id)
    if s.status != "active": return s
    s.ended_at=now_utc(); s.elapsed_seconds=max(0,int((s.ended_at-s.started_at).total_seconds())); s.status="completed"; s.version+=1; db.flush(); return s
