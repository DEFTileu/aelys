from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal
from uuid import NAMESPACE_URL, uuid4, uuid5
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.db import get_db
from app.core.models import (
    ActivityEvent,
    CalendarEvent,
    CalendarReminder,
    FinanceAccount,
    FinanceBudget,
    FinanceCategory,
    FinanceTransaction,
    FocusSession,
    HistoryEntry,
    MailAccount,
    MailDraft,
    MailMessage,
    Note,
    NoteRevision,
    Notification,
    Project,
    Resource,
    ResourceLink,
    Task,
    TaskReminder,
)
from app.core.security import current_principal
from app.domains.recurrence import occurrences, parse_rule, utc
from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
class ProjectRef(StrictModel): project_id: str | None = None
class ResourceIn(StrictModel): kind: str = Field(min_length=1, max_length=40); entity_id: str = Field(min_length=1, max_length=100); project_id: str | None = None; metadata: dict = Field(default_factory=dict)
class ProjectPatchIn(StrictModel): version: int | None = None; name: str | None = Field(default=None, min_length=1, max_length=200); description: str | None = None; status: str | None = None
class ResourceLinkIn(StrictModel): from_resource_id: str; to_resource_id: str; relation_type: str = Field(min_length=1, max_length=50)
class FinanceCategoryIn(StrictModel): name: str = Field(min_length=1, max_length=200); kind: str = "expense"
class FinanceBudgetIn(StrictModel):
    category_id: str | None = None
    currency: str = Field(min_length=3, max_length=3)
    period_start: datetime
    period_end: datetime
    limit_amount: Decimal = Field(ge=0, max_digits=20, decimal_places=4)

    @field_validator("limit_amount", mode="before")
    @classmethod
    def budget_decimal(cls, value):
        if isinstance(value, float):
            raise ValueError("limit_amount must be a decimal string")  # noqa: TRY004 - Pydantic needs ValueError for structured money validation
        return value
class NotificationIn(StrictModel): kind: str = Field(default="info", min_length=1, max_length=80); title: str = Field(default="Notification", min_length=1, max_length=300); body: str | None = Field(default=None, max_length=20_000); data: dict = Field(default_factory=dict); dedup_key: str | None = Field(default=None, max_length=150)
class NoteIn(BaseModel):
    title: str
    markdown_body: str = ""
    parent_id: str | None = None
    project_id: str | None = None
    folder: str | None = Field(default=None, max_length=120)
    tags: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("folder")
    @classmethod
    def clean_folder(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, value: list[str]) -> list[str]:
        tags = [tag.strip().removeprefix("#").strip() for tag in value]
        if any(not tag or len(tag) > 80 for tag in tags):
            raise ValueError("Tags must be 1 to 80 characters")
        return list(dict.fromkeys(tags))
class NoteOut(NoteIn): model_config=ConfigDict(from_attributes=True); id: str; version: int; updated_at: datetime | None = None
class TaskIn(BaseModel):
    title: str
    description: str = ""
    project_id: str | None = None
    parent_task_id: str | None = None
    status: str = "todo"
    priority: int = 0
    due_at: datetime | None = None
    due_timezone: str | None = None
    rrule: str | None = None

    @field_validator("due_at")
    @classmethod
    def utc_due_instant(cls, value: datetime | None) -> datetime | None:
        # SQLite drops tzinfo. Normalize incoming offsets before storage and
        # restore UTC on output, matching the existing calendar instant policy.
        return utc(value) if value is not None else None

class TaskOut(TaskIn): model_config=ConfigDict(from_attributes=True); id: str; version: int
class TaskPatchIn(TaskIn): version: int | None = Field(default=None, ge=1)
class EventIn(BaseModel):
    title: str
    description: str = ""
    starts_at: datetime
    ends_at: datetime
    timezone: str = "UTC"
    all_day: bool = False
    project_id: str | None = None
    linked_task_id: str | None = None
    rrule: str | None = None
    reminder_at: datetime | None = None

    @field_validator("starts_at", "ends_at")
    @classmethod
    def utc_instant(cls, value: datetime) -> datetime:
        # SQLite drops timezone metadata. All persisted instants are UTC.
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)

    @model_validator(mode="after")
    def validate_calendar(self):
        try:
            ZoneInfo(self.timezone)
            if self.rrule:
                parse_rule(self.rrule, self.starts_at, self.timezone)
        except (ValueError, KeyError, OverflowError, ZoneInfoNotFoundError) as exc:
            raise ValueError(f"Invalid calendar timezone or RRULE: {exc}") from exc
        if self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        if self.reminder_at and utc(self.reminder_at) >= self.starts_at:
            raise ValueError("reminder_at must precede starts_at")
        return self
class EventOut(EventIn): model_config=ConfigDict(from_attributes=True); id: str; version: int
class EventPatchIn(EventIn): version: int = Field(ge=1)
class EventOccurrence(EventOut):
    occurrence_id: str
    series_starts_at: datetime
    series_ends_at: datetime
class FinanceAccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    currency: str = Field(min_length=3, max_length=3, pattern="^[A-Za-z]{3}$")
    type: str = "cash"

    @field_validator("currency")
    @classmethod
    def upper_currency(cls, value: str) -> str:
        return value.upper()
class TransactionIn(BaseModel):
    account_id: str
    category_id: str | None = None
    amount: Decimal = Field(max_digits=20, decimal_places=4)
    currency: str = Field(min_length=3, max_length=3)
    type: Literal["income", "expense"]
    occurred_at: datetime
    notes: str = ""
    idempotency_key: str | None = Field(default=None, max_length=100)

    @field_validator("amount", mode="before")
    @classmethod
    def transaction_decimal(cls, value):
        if isinstance(value, float):
            raise ValueError("amount must be a decimal string")  # noqa: TRY004 - Pydantic needs ValueError for structured money validation
        return value

    @model_validator(mode="after")
    def posting_sign(self):
        if self.amount == 0:
            raise ValueError("amount cannot be zero")
        self.amount = -abs(self.amount) if self.type == "expense" else abs(self.amount)
        self.currency = self.currency.upper()
        return self
class TransferIn(StrictModel):
    from_account_id: str
    to_account_id: str
    amount: Decimal = Field(gt=0, max_digits=20, decimal_places=4)
    currency: str = Field(min_length=3, max_length=3)
    occurred_at: datetime
    notes: str = Field(default="", max_length=20_000)
    idempotency_key: str = Field(min_length=1, max_length=100)

    @field_validator("amount", mode="before")
    @classmethod
    def reject_float_amount(cls, value):
        if isinstance(value, float):
            raise ValueError("amount must be a decimal string")  # noqa: TRY004 - Pydantic needs ValueError for structured money validation
        return value

class FinanceTransactionOut(StrictModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    owner_id: str
    account_id: str
    category_id: str | None
    amount: Decimal
    currency: str
    type: str
    occurred_at: datetime
    notes: str
    idempotency_key: str | None
    related_transfer_id: str | None
    version: int

class TransferOut(StrictModel):
    transfer_id: str
    debit: FinanceTransactionOut
    credit: FinanceTransactionOut
class FinanceAccountOut(FinanceAccountIn):
    model_config = ConfigDict(from_attributes=True)
    id: str
    owner_id: str
    version: int
class FinanceCategoryOut(FinanceCategoryIn):
    model_config = ConfigDict(from_attributes=True)
    id: str
    owner_id: str
    version: int
class FinanceBudgetOut(FinanceBudgetIn):
    model_config = ConfigDict(from_attributes=True)
    id: str
    owner_id: str
    version: int
class DraftIn(BaseModel): account_id: str | None = None; thread_id: str | None = None; recipients: list[str] = []; subject: str = ""; content: str = ""
class DraftPatch(DraftIn): version: int = Field(ge=1)
class MessageIn(BaseModel): account_id: str | None = None; thread_id: str | None = None; sender: str; recipients: list[str] = []; subject: str; body: str = ""; received_at: datetime; sync_origin: str = "import"
class MailMessageOut(MessageIn):
    model_config = ConfigDict(from_attributes=True)
    id: str
    owner_id: str

    @field_validator("received_at")
    @classmethod
    def received_utc(cls, value: datetime) -> datetime:
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
class FocusIn(BaseModel):
    task_id: str | None = None
    project_id: str | None = None
    started_at: datetime
    mode: Literal["pomodoro", "stopwatch", "custom"] = "pomodoro"

    @field_validator("started_at")
    @classmethod
    def start_utc(cls, value: datetime) -> datetime:
        return utc(value)
class FocusOut(FocusIn):
    model_config = ConfigDict(from_attributes=True)
    id: str
    owner_id: str
    ended_at: datetime | None
    elapsed_seconds: int
    status: str
    version: int

    @field_validator("started_at", "ended_at")
    @classmethod
    def focus_utc(cls, value: datetime | None) -> datetime | None:
        return None if value is None else value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)

    @model_validator(mode="after")
    def active_elapsed(self):
        if self.status == "active" and self.ended_at is None:
            self.elapsed_seconds = max(self.elapsed_seconds, int((datetime.now(UTC) - self.started_at).total_seconds()))
        return self
class MailAccountIn(BaseModel): provider: str = "local_import"; external_id: str | None = None
class ReminderIn(BaseModel): task_id: str; notify_at: datetime; channel: str = "in_app"; idempotency_key: str
class CalendarReminderIn(BaseModel):
    event_id: str
    notify_at: datetime
    channel: Literal["in_app"] = "in_app"
    idempotency_key: str = Field(min_length=1, max_length=100)
class CalendarReminderOut(CalendarReminderIn):
    model_config = ConfigDict(from_attributes=True)
    id: str
    owner_id: str
    reminder_status: str
    version: int

    @field_validator("notify_at")
    @classmethod
    def reminder_utc(cls, value: datetime) -> datetime:
        return utc(value)

async def owner_obj(model: type[Any], item_id: str, owner_id: str, db: AsyncSession):
    item = await db.get(model, item_id)
    if not item or item.owner_id != owner_id or item.deleted_at is not None: raise HTTPException(404, detail={"code":"NOT_FOUND","message":"Resource not found"})
    return item

async def owned_ref(model: type[Any], item_id: str | None, owner_id: str, db: AsyncSession, *, required: bool = False):
    """Resolve a foreign reference inside the authenticated owner's scope."""
    if item_id is None:
        if required:
            raise HTTPException(422, detail={"code":"VALIDATION_ERROR","message":"Referenced resource is required"})
        return None
    item = await db.get(model, item_id)
    if not item or item.owner_id != owner_id or getattr(item, "deleted_at", None) is not None:
        raise HTTPException(404, detail={"code":"NOT_FOUND","message":"Referenced resource not found"})
    return item

@router.get("/projects/{project_id}/resources")
async def project_resources(project_id: str, principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user,_=principal; await owner_obj(Project,project_id,user.id,db)
    return list((await db.execute(select(Resource).where(Resource.owner_id==user.id,Resource.project_id==project_id))).scalars())
@router.post("/resources")
async def create_resource(body: ResourceIn, principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user,_=principal
    await owned_ref(Project, body.project_id, user.id, db)
    metadata=body.metadata
    if not isinstance(metadata,dict):
        raise HTTPException(422, detail={"code":"VALIDATION_ERROR","message":"metadata must be an object"})
    if body.kind=="agent_session" and any(k not in {"adapter","state","message_count","started_at","last_activity_at"} for k in metadata):
        raise HTTPException(422, detail={"code":"PRIVACY_VIOLATION","message":"Agent session metadata is allowlisted"})
    item=Resource(owner_id=user.id,kind=body.kind,entity_id=body.entity_id,project_id=body.project_id,metadata_json=metadata)
    db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/projects/{project_id}")
async def get_project(project_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return await owner_obj(Project,project_id,user.id,db)
@router.patch("/projects/{project_id}")
async def update_project(project_id:str,body:ProjectPatchIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(Project,project_id,user.id,db)
    if body.version is not None and body.version!=item.version: raise HTTPException(409,detail={"code":"VERSION_CONFLICT","message":"Concurrent update","details":{"server_version":item.version}})
    for key in ("name","description","status"):
        value = getattr(body, key)
        if value is not None: setattr(item,key,value)
    item.version+=1; await db.commit(); return item
@router.delete("/projects/{project_id}")
async def delete_project(project_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(Project,project_id,user.id,db); item.deleted_at=datetime.now(UTC); item.version+=1; await db.commit(); return {"deleted":True}

@router.post("/resource-links")
async def link_resources(body: ResourceLinkIn, principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user,_=principal
    left=await owner_obj(Resource,body.from_resource_id,user.id,db); right=await owner_obj(Resource,body.to_resource_id,user.id,db)
    if left.id==right.id: raise HTTPException(409, detail={"code":"VALIDATION_ERROR","message":"Self links are not allowed"})
    item=ResourceLink(owner_id=user.id,from_resource_id=left.id,to_resource_id=right.id,relation_type=body.relation_type); db.add(item)
    try: await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, detail={"code":"DUPLICATE","message":"Link already exists"}) from None
    return {"id":item.id}
@router.delete("/resource-links/{link_id}")
async def unlink_resources(link_id: str, principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(ResourceLink,link_id,user.id,db); item.deleted_at=datetime.now(UTC); item.version+=1; await db.commit(); return {"deleted":True}

@router.get("/notes", response_model=list[NoteOut])
async def notes(principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(Note).where(Note.owner_id==user.id,Note.deleted_at.is_(None)))).scalars())
@router.post("/notes", response_model=NoteOut)
async def create_note(body:NoteIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,device=principal
    await owned_ref(Project, body.project_id, user.id, db)
    await owned_ref(Note, body.parent_id, user.id, db)
    item=Note(owner_id=user.id,**body.model_dump()); db.add(item); await db.flush(); db.add(NoteRevision(note_id=item.id,base_version=0,revision_no=1,body=item.markdown_body,source_device_id=device.id if device else None)); await db.commit(); await db.refresh(item); return item
@router.get("/notes/{item_id}", response_model=NoteOut)
async def get_note(item_id:str, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; return await owner_obj(Note,item_id,user.id,db)
@router.patch("/notes/{item_id}", response_model=NoteOut)
async def update_note(item_id:str, body:NoteIn, version: int | None = Query(default=None, ge=1), principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user, device = principal
    item = await owner_obj(Note, item_id, user.id, db)
    await owned_ref(Project, body.project_id, user.id, db)
    await owned_ref(Note, body.parent_id, user.id, db)
    expected = version if version is not None else item.version
    changed_body = body.markdown_body != item.markdown_body
    values = body.model_dump()
    # Older clients do not send organization fields; preserve them on update.
    for field in ("folder", "tags"):
        if field not in body.model_fields_set:
            values.pop(field)
    result = await db.execute(update(Note).where(
        Note.id == item_id, Note.owner_id == user.id, Note.deleted_at.is_(None),
        Note.version == expected,
    ).values(**values, version=expected + 1))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(409, detail={"code": "VERSION_CONFLICT", "message": "Note changed. Your draft must be compared with the latest version before saving."})
    if changed_body:
        db.add(NoteRevision(note_id=item.id, base_version=expected, revision_no=expected + 1, body=body.markdown_body, source_device_id=device.id if device else None))
    await db.commit()
    await db.refresh(item)
    return item
@router.get("/notes/{item_id}/revisions")
async def note_revisions(item_id:str, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; await owner_obj(Note,item_id,user.id,db); return list((await db.execute(select(NoteRevision).where(NoteRevision.note_id==item_id).order_by(NoteRevision.revision_no))).scalars())
@router.post("/notes/{item_id}/restore")
async def restore_note(item_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(Note,item_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Note not found"})
    revisions=list((await db.execute(select(NoteRevision).where(NoteRevision.note_id==item_id).order_by(NoteRevision.revision_no.desc()).limit(1))).scalars())
    if revisions: item.markdown_body=revisions[0].body
    item.deleted_at=None; item.version+=1; await db.commit(); return item
@router.delete("/notes/{item_id}")
async def delete_note(item_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(Note,item_id,user.id,db); item.deleted_at=datetime.now(UTC); item.version+=1; await db.commit(); return {"deleted":True}

@router.get("/tasks", response_model=list[TaskOut])
async def tasks(project_id:str|None=None, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; q=select(Task).where(Task.owner_id==user.id,Task.deleted_at.is_(None));
    if project_id: q=q.where(Task.project_id==project_id)
    return list((await db.execute(q)).scalars())
@router.post("/tasks", response_model=TaskOut)
async def create_task(body:TaskIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal
    await owned_ref(Project, body.project_id, user.id, db)
    await owned_ref(Task, body.parent_task_id, user.id, db)
    item=Task(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/tasks/{item_id}", response_model=TaskOut)
async def get_task(item_id:str, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; return await owner_obj(Task,item_id,user.id,db)
@router.patch("/tasks/{item_id}", response_model=TaskOut)
async def update_task(item_id:str, body:TaskPatchIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(Task,item_id,user.id,db)
    await owned_ref(Project, body.project_id, user.id, db)
    await owned_ref(Task, body.parent_task_id, user.id, db)
    version = body.version if body.version is not None else item.version
    result = await db.execute(update(Task).where(Task.id == item_id, Task.owner_id == user.id, Task.version == version, Task.deleted_at.is_(None)).values(**body.model_dump(exclude={"version"}), version=version + 1))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(409, detail={"code": "VERSION_CONFLICT", "message": "Task changed. Reload before saving."})
    await db.commit(); await db.refresh(item); return item
@router.delete("/tasks/{item_id}")
async def delete_task(item_id: str, version: int | None = Query(default=None, ge=1), principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    item = await owner_obj(Task, item_id, user.id, db)
    if version is None:
        item.deleted_at = datetime.now(UTC)
        item.version += 1
    else:
        result = await db.execute(
            update(Task)
            .where(Task.id == item_id, Task.owner_id == user.id, Task.deleted_at.is_(None), Task.version == version)
            .values(deleted_at=datetime.now(UTC), version=Task.version + 1)
        )
        if int(getattr(result, "rowcount", 0) or 0) != 1:
            await db.rollback()
            raise HTTPException(409, detail={"code": "VERSION_CONFLICT", "message": "Task changed. Reload before deleting."})
    await db.commit()
    return {"deleted": True}

@router.post("/tasks/{item_id}/reminders")
async def create_reminder(item_id:str, body:ReminderIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; task=await owner_obj(Task,item_id,user.id,db)
    if body.task_id != task.id: raise HTTPException(422,detail={"code":"VALIDATION_ERROR","message":"task_id does not match path"})
    old=(await db.execute(select(TaskReminder).where(TaskReminder.owner_id==user.id,TaskReminder.idempotency_key==body.idempotency_key))).scalar_one_or_none()
    if old: return old
    item=TaskReminder(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/tasks/{item_id}/reminders")
async def list_reminders(item_id:str, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; await owner_obj(Task,item_id,user.id,db)
    return list((await db.execute(select(TaskReminder).where(TaskReminder.owner_id==user.id,TaskReminder.task_id==item_id,TaskReminder.deleted_at.is_(None)))).scalars())

@router.get("/calendar/events", response_model=list[EventOut])
async def events(principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal
    return list((await db.execute(select(CalendarEvent).where(CalendarEvent.owner_id==user.id,CalendarEvent.deleted_at.is_(None)))).scalars())
@router.get("/calendar/occurrences", response_model=list[EventOccurrence])
async def calendar_occurrences(starts_at: datetime, ends_at: datetime, principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user, _ = principal
    lower, upper = utc(starts_at), utc(ends_at)
    if upper <= lower or upper - lower > timedelta(days=366):
        raise HTTPException(422, detail={"code": "CALENDAR_RANGE_INVALID", "message": "Choose a positive window of at most 366 days"})
    rows = list((await db.execute(select(CalendarEvent).where(CalendarEvent.owner_id == user.id, CalendarEvent.deleted_at.is_(None), CalendarEvent.starts_at < upper, or_(CalendarEvent.ends_at > lower, CalendarEvent.rrule.is_not(None))).limit(1001))).scalars())
    if len(rows) > 1000:
        raise HTTPException(422, detail={"code": "RECURRENCE_LIMIT", "message": "Calendar projection exceeds 1000 series"})
    result = []
    for item in rows:
        series = EventOut.model_validate(item)
        try:
            instances = occurrences(item.starts_at, item.ends_at, item.timezone, item.rrule, lower, upper)
        except ValueError as exc:
            raise HTTPException(422, detail={"code": "RECURRENCE_LIMIT", "message": str(exc)}) from exc
        for start, end in instances:
            result.append(EventOccurrence(**{**series.model_dump(), "starts_at": start, "ends_at": end}, occurrence_id=f"{item.id}:{start.isoformat()}", series_starts_at=series.starts_at, series_ends_at=series.ends_at))
            if len(result) > 1000:
                raise HTTPException(422, detail={"code": "RECURRENCE_LIMIT", "message": "Choose a smaller calendar window"})
    return sorted(result, key=lambda item: item.starts_at)
@router.post("/calendar/events", response_model=EventOut)
async def create_event(body:EventIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db), idempotency_key: str | None = Header(default=None, max_length=150)):
    if body.ends_at<body.starts_at: raise HTTPException(422,detail={"code":"VALIDATION_ERROR","message":"ends_at must not precede starts_at"})
    user,_=principal
    await owned_ref(Project, body.project_id, user.id, db)
    await owned_ref(Task, body.linked_task_id, user.id, db)
    item_id = str(uuid5(NAMESPACE_URL, f"aelys:event:{user.id}:{idempotency_key}")) if idempotency_key else str(uuid4())
    existing = (await db.execute(select(CalendarEvent).where(CalendarEvent.id == item_id))).scalar_one_or_none()
    if existing:
        recorded = EventOut.model_validate(existing).model_dump(exclude={"id", "version", "reminder_at"})
        if recorded != body.model_dump(exclude={"reminder_at"}):
            raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Calendar key is bound to another event"})
        initial = (await db.execute(select(CalendarReminder).where(CalendarReminder.owner_id == user.id, CalendarReminder.idempotency_key == f"event:{item_id}:initial"))).scalar_one_or_none()
        requested_offset = int((body.starts_at - utc(body.reminder_at)).total_seconds()) if body.reminder_at else None
        if (initial is None) != (body.reminder_at is None) or (initial and initial.offset_seconds != requested_offset):
            raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Calendar key is bound to another reminder schedule"})
        return existing
    item=CalendarEvent(id=item_id, owner_id=user.id,**body.model_dump(exclude={"reminder_at"})); db.add(item)
    try:
        await db.flush()
        if body.reminder_at:
            db.add(CalendarReminder(owner_id=user.id, event_id=item.id, notify_at=utc(body.reminder_at), offset_seconds=int((body.starts_at-utc(body.reminder_at)).total_seconds()), occurrence_at=body.starts_at, idempotency_key=f"event:{item.id}:initial"))
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if idempotency_key and (await db.execute(select(CalendarEvent).where(CalendarEvent.id == item_id))).scalar_one_or_none():
            return await create_event(body, principal=principal, db=db, idempotency_key=idempotency_key)
        raise
    await db.refresh(item); return item
@router.get("/calendar/events/{item_id}", response_model=EventOut)
async def get_event(item_id:str, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; return await owner_obj(CalendarEvent,item_id,user.id,db)
@router.patch("/calendar/events/{item_id}", response_model=EventOut)
async def update_event(item_id:str,body:EventPatchIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(CalendarEvent,item_id,user.id,db)
    if body.ends_at<body.starts_at: raise HTTPException(422,detail={"code":"VALIDATION_ERROR","message":"ends_at must not precede starts_at"})
    await owned_ref(Project, body.project_id, user.id, db)
    await owned_ref(Task, body.linked_task_id, user.id, db)
    result = await db.execute(update(CalendarEvent).where(CalendarEvent.id == item_id, CalendarEvent.owner_id == user.id, CalendarEvent.version == body.version).values(**body.model_dump(exclude={"version", "reminder_at"}), version=body.version + 1))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(409, detail={"code":"VERSION_CONFLICT","message":"Event changed. Reload before saving."})
    if body.reminder_at:
        await db.execute(update(CalendarReminder).where(CalendarReminder.event_id == item_id, CalendarReminder.owner_id == user.id, CalendarReminder.reminder_status == "pending").values(reminder_status="cancelled", version=CalendarReminder.version + 1))
        db.add(CalendarReminder(owner_id=user.id, event_id=item_id, notify_at=utc(body.reminder_at), offset_seconds=int((body.starts_at-utc(body.reminder_at)).total_seconds()), occurrence_at=body.starts_at, idempotency_key=f"event:{item_id}:v{body.version + 1}"))
    await db.commit(); await db.refresh(item); return item
@router.delete("/calendar/events/{item_id}")
async def delete_event(item_id:str,version:int=Query(ge=1),principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; await owner_obj(CalendarEvent,item_id,user.id,db)
    result = await db.execute(update(CalendarEvent).where(CalendarEvent.id == item_id, CalendarEvent.owner_id == user.id, CalendarEvent.version == version).values(deleted_at=datetime.now(UTC), version=version + 1))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(409, detail={"code":"VERSION_CONFLICT","message":"Event changed. Reload before deleting."})
    await db.commit(); return {"deleted":True}

@router.get("/calendar/events/{item_id}/reminders", response_model=list[CalendarReminderOut])
async def calendar_reminders(item_id: str, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    await owner_obj(CalendarEvent, item_id, user.id, db)
    return list((await db.execute(select(CalendarReminder).where(CalendarReminder.owner_id == user.id, CalendarReminder.event_id == item_id, CalendarReminder.deleted_at.is_(None)).order_by(CalendarReminder.notify_at))).scalars())

@router.post("/calendar/events/{item_id}/reminders", response_model=CalendarReminderOut)
async def create_calendar_reminder(item_id: str, body: CalendarReminderIn, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    event = await owner_obj(CalendarEvent, item_id, user.id, db)
    if body.event_id != item_id:
        raise HTTPException(422, detail={"code": "VALIDATION_ERROR", "message": "event_id must match the URL"})
    if utc(body.notify_at) >= utc(event.starts_at):
        raise HTTPException(422, detail={"code": "VALIDATION_ERROR", "message": "Reminder must precede event start"})
    old = (await db.execute(select(CalendarReminder).where(CalendarReminder.owner_id == user.id, CalendarReminder.idempotency_key == body.idempotency_key))).scalar_one_or_none()
    if old:
        if old.event_id != item_id or utc(old.notify_at) != utc(body.notify_at):
            raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Reminder key is bound to a different request"})
        return old
    item = CalendarReminder(owner_id=user.id, offset_seconds=int((utc(event.starts_at)-utc(body.notify_at)).total_seconds()), occurrence_at=utc(event.starts_at), **body.model_dump())
    db.add(item); await db.commit(); await db.refresh(item); return item

@router.delete("/calendar/events/{event_id}/reminders/{reminder_id}")
async def cancel_calendar_reminder(event_id: str, reminder_id: str, version: int = Query(ge=1), principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    await owner_obj(CalendarEvent, event_id, user.id, db)
    reminder = await owner_obj(CalendarReminder, reminder_id, user.id, db)
    if reminder.event_id != event_id:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Reminder not found"})
    result = await db.execute(update(CalendarReminder).where(CalendarReminder.id == reminder_id, CalendarReminder.version == version).values(deleted_at=datetime.now(UTC), reminder_status="cancelled", version=version + 1))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(409, detail={"code": "VERSION_CONFLICT", "message": "Reminder changed; reload before cancelling"})
    await db.commit()
    return {"deleted": True}

@router.post("/calendar/reminders/dispatch")
async def dispatch_calendar_reminders(principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    from app.ai.errors import PolicyDenied
    from app.domains.reminders import deliver_due_reminders
    user, _ = principal
    try:
        return {"delivered": await deliver_due_reminders(db, user.id)}
    except PolicyDenied as exc:
        await db.rollback()
        raise HTTPException(403, detail={"code": "POLICY_DENIED", "message": "Reminder delivery denied by policy"}) from exc

async def create_personal_record(model, body: BaseModel, owner_id: str, key: str | None, db: AsyncSession):
    """Bind owner-scoped create IDs to stable operation keys, including lost responses."""
    item_id = str(uuid5(NAMESPACE_URL, f"aelys:{model.__tablename__}:{owner_id}:{key}")) if key else str(uuid4())
    values = body.model_dump()
    item = await db.get(model, item_id)
    if item is None:
        item = model(id=item_id, owner_id=owner_id, **values)
        db.add(item)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            item = await db.get(model, item_id)
            if item is None:
                raise
        await db.refresh(item)
    for field, value in values.items():
        persisted = getattr(item, field)
        if isinstance(value, datetime):
            value, persisted = utc(value), utc(persisted)
        if value != persisted:
            raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Operation key is bound to a different request"})
    return item

@router.post("/finance/accounts", response_model=FinanceAccountOut)
async def create_account(body:FinanceAccountIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db), idempotency_key: str | None = Header(default=None, max_length=150)):
    user,_=principal; return await create_personal_record(FinanceAccount, body, user.id, idempotency_key, db)
@router.get("/finance/accounts", response_model=list[FinanceAccountOut])
async def accounts(principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(FinanceAccount).where(FinanceAccount.owner_id==user.id,FinanceAccount.deleted_at.is_(None)))).scalars())
@router.post("/finance/categories", response_model=FinanceCategoryOut)
async def create_category(body:FinanceCategoryIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db), idempotency_key: str | None = Header(default=None, max_length=150)):
    user,_=principal; return await create_personal_record(FinanceCategory, body, user.id, idempotency_key, db)
@router.get("/finance/categories", response_model=list[FinanceCategoryOut])
async def categories(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(FinanceCategory).where(FinanceCategory.owner_id==user.id,FinanceCategory.deleted_at.is_(None)))).scalars())
@router.post("/finance/budgets", response_model=FinanceBudgetOut)
async def create_budget(body:FinanceBudgetIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db), idempotency_key: str | None = Header(default=None, max_length=150)):
    user,_=principal; await owned_ref(FinanceCategory, body.category_id, user.id, db)
    if body.period_end <= body.period_start: raise HTTPException(422, detail={"code":"VALIDATION_ERROR","message":"period_end must be after period_start"})
    return await create_personal_record(FinanceBudget, body, user.id, idempotency_key, db)
@router.get("/finance/budgets", response_model=list[FinanceBudgetOut])
async def budgets(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(FinanceBudget).where(FinanceBudget.owner_id==user.id,FinanceBudget.deleted_at.is_(None)))).scalars())
@router.get("/finance/transactions", response_model=list[FinanceTransactionOut])
async def transactions(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(FinanceTransaction).where(FinanceTransaction.owner_id==user.id,FinanceTransaction.deleted_at.is_(None)).order_by(FinanceTransaction.occurred_at.desc()))).scalars())
@router.post("/finance/transactions", response_model=FinanceTransactionOut)
async def create_transaction(body:TransactionIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db), idempotency_key: str | None = Header(default=None, max_length=100)):
    user,_=principal
    body.idempotency_key = body.idempotency_key or idempotency_key
    account = await owned_ref(FinanceAccount, body.account_id, user.id, db, required=True)
    category = await owned_ref(FinanceCategory, body.category_id, user.id, db)
    if account.currency.upper() != body.currency or (category and category.kind != body.type):
        raise HTTPException(422, detail={"code": "VALIDATION_ERROR", "message": "Account currency and category kind must match the transaction"})
    if body.idempotency_key:
        old=(await db.execute(select(FinanceTransaction).where(FinanceTransaction.owner_id==user.id,FinanceTransaction.idempotency_key==body.idempotency_key))).scalar_one_or_none()
        if old:
            if old.account_id != body.account_id or old.category_id != body.category_id or old.amount != body.amount or old.currency != body.currency or old.type != body.type or utc(old.occurred_at) != utc(body.occurred_at) or old.notes != body.notes:
                raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Posting key is bound to another transaction"})
            return old
    return await create_personal_record(FinanceTransaction, body, user.id, body.idempotency_key, db)

async def _transfer_response(transfer_id: str, owner_id: str, db: AsyncSession) -> TransferOut:
    rows = list((await db.execute(
        select(FinanceTransaction)
        .where(
            FinanceTransaction.owner_id == owner_id,
            FinanceTransaction.related_transfer_id == transfer_id,
            FinanceTransaction.deleted_at.is_(None),
        )
        .order_by(FinanceTransaction.amount.asc())
    )).scalars())
    if len(rows) != 2:
        raise HTTPException(500, detail={"code": "TRANSFER_INTEGRITY_ERROR", "message": "Transfer is incomplete"})
    debit, credit = rows
    if debit.amount >= 0 or credit.amount <= 0 or debit.amount + credit.amount != 0:
        raise HTTPException(500, detail={"code": "TRANSFER_INTEGRITY_ERROR", "message": "Transfer is unbalanced"})
    return TransferOut(transfer_id=transfer_id, debit=FinanceTransactionOut.model_validate(debit), credit=FinanceTransactionOut.model_validate(credit))

@router.post("/finance/transfers", response_model=TransferOut)
async def create_transfer(body: TransferIn, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    existing = (await db.execute(
        select(FinanceTransaction).where(
            FinanceTransaction.owner_id == user.id,
            FinanceTransaction.idempotency_key == body.idempotency_key,
        )
    )).scalar_one_or_none()
    if existing:
        if not existing.related_transfer_id:
            raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Idempotency key belongs to another transaction"})
        return await _transfer_response(existing.related_transfer_id, user.id, db)

    if body.amount <= 0:
        raise HTTPException(422, detail={"code": "VALIDATION_ERROR", "message": "amount must be greater than zero"})
    if body.from_account_id == body.to_account_id:
        raise HTTPException(422, detail={"code": "VALIDATION_ERROR", "message": "Transfer accounts must differ"})
    from_account = await owned_ref(FinanceAccount, body.from_account_id, user.id, db, required=True)
    to_account = await owned_ref(FinanceAccount, body.to_account_id, user.id, db, required=True)
    if from_account.currency != body.currency or to_account.currency != body.currency:
        raise HTTPException(422, detail={"code": "VALIDATION_ERROR", "message": "Transfer currency must match both accounts"})

    transfer_id = str(uuid4())
    debit = FinanceTransaction(
        owner_id=user.id,
        account_id=from_account.id,
        category_id=None,
        amount=-body.amount,
        currency=body.currency,
        type="transfer",
        occurred_at=body.occurred_at,
        notes=body.notes,
        idempotency_key=body.idempotency_key,
        related_transfer_id=transfer_id,
    )
    credit = FinanceTransaction(
        owner_id=user.id,
        account_id=to_account.id,
        category_id=None,
        amount=body.amount,
        currency=body.currency,
        type="transfer",
        occurred_at=body.occurred_at,
        notes=body.notes,
        idempotency_key=None,
        related_transfer_id=transfer_id,
    )
    db.add_all([debit, credit])
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = (await db.execute(
            select(FinanceTransaction).where(
                FinanceTransaction.owner_id == user.id,
                FinanceTransaction.idempotency_key == body.idempotency_key,
            )
        )).scalar_one_or_none()
        if existing and existing.related_transfer_id:
            return await _transfer_response(existing.related_transfer_id, user.id, db)
        raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Idempotency key already exists"})
    return await _transfer_response(transfer_id, user.id, db)
@router.get("/finance/summary")
async def finance_summary(principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal
    rows=list((await db.execute(select(FinanceTransaction).where(FinanceTransaction.owner_id==user.id,FinanceTransaction.deleted_at.is_(None)))).scalars())
    groups: dict[str, dict[str, Decimal]] = {}
    for row in rows:
        group = groups.setdefault(row.currency, {"balance": Decimal(0), "income": Decimal(0), "expense": Decimal(0)})
        signed = -abs(row.amount) if row.type == "expense" else abs(row.amount) if row.type == "income" else row.amount
        group["balance"] += signed
        if row.type in {"income", "expense"}:
            group[row.type] += abs(row.amount)
    currencies = [{"currency": currency, **{key: str(value) for key, value in group.items()}} for currency, group in sorted(groups.items())]
    return {"total": currencies[0]["balance"] if len(currencies) == 1 else "0" if not currencies else None, "count": len(rows), "currencies": currencies}

@router.post("/focus/sessions", response_model=FocusOut)
async def start_focus(body:FocusIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db), idempotency_key: str | None = Header(default=None, max_length=150)):
    user,_=principal; await owned_ref(Project, body.project_id, user.id, db); await owned_ref(Task, body.task_id, user.id, db)
    item_id = str(uuid5(NAMESPACE_URL, f"aelys:focus:{user.id}:{idempotency_key}")) if idempotency_key else str(uuid4())
    existing = await db.get(FocusSession, item_id)
    if existing:
        if existing.task_id != body.task_id or existing.project_id != body.project_id or existing.mode != body.mode or utc(existing.started_at) != body.started_at:
            raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Focus start key is bound to another request"})
        return existing
    active=(await db.execute(select(FocusSession).where(FocusSession.owner_id==user.id,FocusSession.status=="active"))).scalar_one_or_none()
    if active: raise HTTPException(409,detail={"code":"TIMER_ACTIVE","message":"Only one active focus session is allowed"})
    item=FocusSession(id=item_id,owner_id=user.id,**body.model_dump()); db.add(item)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        existing = await db.get(FocusSession, item_id)
        if existing:
            return existing
        raise HTTPException(409, detail={"code": "TIMER_ACTIVE", "message": "Another device started a focus session. Reload to see it."}) from exc
    await db.refresh(item); return item
@router.get("/focus/sessions", response_model=list[FocusOut])
async def focus_sessions(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(FocusSession).where(FocusSession.owner_id==user.id).order_by(FocusSession.started_at.desc()))).scalars())
@router.post("/focus/sessions/{item_id}/stop", response_model=FocusOut)
async def stop_focus(item_id:str,version:int | None=Query(default=None,ge=1),principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(FocusSession,item_id,user.id,db)
    if item.status == "completed":
        return item
    if version is not None and item.version != version:
        raise HTTPException(409, detail={"code": "VERSION_CONFLICT", "message": "Focus session changed. Reload before stopping."})
    ended_at = datetime.now(UTC)
    result = await db.execute(update(FocusSession).where(FocusSession.id == item_id, FocusSession.owner_id == user.id, FocusSession.version == item.version, FocusSession.status == "active").values(ended_at=ended_at, elapsed_seconds=max(0, int((ended_at-utc(item.started_at)).total_seconds())), status="completed", version=item.version + 1))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(409, detail={"code": "VERSION_CONFLICT", "message": "Another device changed the focus session. Reload."})
    await db.commit(); await db.refresh(item); return item
@router.post("/mail/import/eml", response_model=MailMessageOut)
async def import_eml(file: UploadFile = File(), principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    from .eml import parse_eml
    user, _ = principal
    raw = await file.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise HTTPException(413, detail={"code":"IMPORT_TOO_LARGE","message":"EML import limit is 2 MB"})
    item_id = str(uuid5(NAMESPACE_URL, f"aelys:mail:{user.id}:{hashlib.sha256(raw).hexdigest()}"))
    existing = await db.get(MailMessage, item_id)
    if existing:
        return existing
    item = MailMessage(id=item_id, owner_id=user.id, **parse_eml(raw))
    db.add(item)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = await db.get(MailMessage, item_id)
        if existing: return existing
        raise
    await db.refresh(item)
    return item

@router.post("/mail/messages", response_model=MailMessageOut)
async def import_message(body:MessageIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; await owned_ref(MailAccount, body.account_id, user.id, db)
    item=MailMessage(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/mail/messages", response_model=list[MailMessageOut])
async def mail_messages(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(MailMessage).where(MailMessage.owner_id==user.id,MailMessage.deleted_at.is_(None)).order_by(MailMessage.received_at.desc()))).scalars())
@router.post("/mail/accounts")
async def create_mail_account(body:MailAccountIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; item=MailAccount(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/mail/accounts")
async def mail_accounts(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(MailAccount).where(MailAccount.owner_id==user.id,MailAccount.deleted_at.is_(None)))).scalars())
@router.post("/mail/drafts")
async def create_draft(body:DraftIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; await owned_ref(MailAccount, body.account_id, user.id, db)
    item=MailDraft(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/mail/drafts")
async def mail_drafts(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(MailDraft).where(MailDraft.owner_id==user.id,MailDraft.deleted_at.is_(None)))).scalars())
@router.patch("/mail/drafts/{draft_id}")
async def update_draft(draft_id: str, body: DraftPatch, principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user, _ = principal
    item = await owner_obj(MailDraft, draft_id, user.id, db)
    await owned_ref(MailAccount, body.account_id, user.id, db)
    result = await db.execute(update(MailDraft).where(
        MailDraft.id == draft_id, MailDraft.owner_id == user.id, MailDraft.version == body.version,
    ).values(**body.model_dump(exclude={"version"}), version=body.version + 1))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(409, detail={"code":"VERSION_CONFLICT","message":"Draft changed. Reload before saving."})
    await db.commit(); await db.refresh(item)
    return item

@router.delete("/mail/drafts/{draft_id}")
async def delete_draft(draft_id: str, version: int = Query(ge=1), principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user, _ = principal
    await owner_obj(MailDraft, draft_id, user.id, db)
    result = await db.execute(update(MailDraft).where(
        MailDraft.id == draft_id, MailDraft.owner_id == user.id, MailDraft.version == version,
    ).values(deleted_at=datetime.now(UTC), version=version + 1))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(409, detail={"code":"VERSION_CONFLICT","message":"Draft changed. Reload before deleting."})
    await db.commit()
    return {"deleted": True}
@router.get("/search")
async def search(q:str=Query(min_length=1,max_length=200), principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user, _ = principal
    needle = f"%{q}%"
    out: list[dict[str, str]] = []
    # Match against bodies in SQL but transfer only the result fields. Loading
    # full ORM entities needlessly copies every large note/mail body into Python.
    for model, title, fields, kind in [
        (Note, Note.title, [Note.title, Note.markdown_body], "note"),
        (Task, Task.title, [Task.title, Task.description], "task"),
        (MailMessage, MailMessage.subject, [MailMessage.subject, MailMessage.body], "mail"),
    ]:
        rows = await db.execute(select(model.id, title).where(
            model.owner_id == user.id,
            model.deleted_at.is_(None),
            or_(*[field.ilike(needle) for field in fields]),
        ))
        out.extend({"kind": kind, "id": row[0], "title": row[1]} for row in rows)
    return {"results": out}

@router.get("/activity")
async def activity(principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(ActivityEvent).where(ActivityEvent.owner_id==user.id).order_by(ActivityEvent.occurred_at.desc()).limit(200))).scalars())
@router.get("/history")
async def history(principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(HistoryEntry).where(HistoryEntry.owner_id==user.id).order_by(HistoryEntry.created_at.desc()).limit(200))).scalars())
@router.get("/notifications")
async def notifications(principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(Notification).where(Notification.owner_id==user.id,Notification.deleted_at.is_(None)).order_by(Notification.created_at.desc()).limit(200))).scalars())
@router.post("/notifications")
async def create_notification(body:NotificationIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; item=Notification(owner_id=user.id,kind=body.kind,title=body.title,body=body.body,data_json=body.data,dedup_key=body.dedup_key); db.add(item); await db.commit(); await db.refresh(item); return item
@router.post("/notifications/{item_id}/read")
async def mark_notification_read(item_id:str, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(Notification,item_id,user.id,db); item.read_at=datetime.now(UTC); await db.commit(); return item
