from __future__ import annotations
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.db import get_db
from app.core.models import ActivityEvent, CalendarEvent, FinanceAccount, FinanceBudget, FinanceCategory, FinanceTransaction, FocusSession, HistoryEntry, MailAccount, MailDraft, MailMessage, Note, NoteRevision, Notification, Project, Resource, ResourceLink, Task, TaskReminder
from app.core.security import current_principal

router = APIRouter()

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
class ProjectRef(StrictModel): project_id: str | None = None
class ResourceIn(StrictModel): kind: str = Field(min_length=1, max_length=40); entity_id: str = Field(min_length=1, max_length=100); project_id: str | None = None; metadata: dict = Field(default_factory=dict)
class ProjectPatchIn(StrictModel): version: int | None = None; name: str | None = Field(default=None, min_length=1, max_length=200); description: str | None = None; status: str | None = None
class ResourceLinkIn(StrictModel): from_resource_id: str; to_resource_id: str; relation_type: str = Field(min_length=1, max_length=50)
class FinanceCategoryIn(StrictModel): name: str = Field(min_length=1, max_length=200); kind: str = "expense"
class FinanceBudgetIn(StrictModel): category_id: str | None = None; currency: str = Field(min_length=3, max_length=3); period_start: datetime; period_end: datetime; limit_amount: Decimal
class NotificationIn(StrictModel): kind: str = Field(default="info", min_length=1, max_length=80); title: str = Field(default="Notification", min_length=1, max_length=300); body: str | None = Field(default=None, max_length=20_000); data: dict = Field(default_factory=dict); dedup_key: str | None = Field(default=None, max_length=150)
class NoteIn(BaseModel): title: str; markdown_body: str = ""; parent_id: str | None = None; project_id: str | None = None
class NoteOut(NoteIn): model_config=ConfigDict(from_attributes=True); id: str; version: int
class TaskIn(BaseModel): title: str; description: str = ""; project_id: str | None = None; parent_task_id: str | None = None; status: str = "todo"; priority: int = 0; due_at: datetime | None = None; due_timezone: str | None = None; rrule: str | None = None
class TaskOut(TaskIn): model_config=ConfigDict(from_attributes=True); id: str; version: int
class EventIn(BaseModel): title: str; description: str = ""; starts_at: datetime; ends_at: datetime; timezone: str = "UTC"; all_day: bool = False; project_id: str | None = None; linked_task_id: str | None = None; rrule: str | None = None
class EventOut(EventIn): model_config=ConfigDict(from_attributes=True); id: str; version: int
class FinanceAccountIn(BaseModel): name: str; currency: str = Field(min_length=3,max_length=3); type: str = "cash"
class TransactionIn(BaseModel): account_id: str; category_id: str | None = None; amount: Decimal; currency: str = Field(min_length=3,max_length=3); type: str; occurred_at: datetime; notes: str = ""; idempotency_key: str | None = None
class TransferIn(StrictModel):
    from_account_id: str
    to_account_id: str
    amount: Decimal
    currency: str = Field(min_length=3, max_length=3)
    occurred_at: datetime
    notes: str = Field(default="", max_length=20_000)
    idempotency_key: str = Field(min_length=1, max_length=100)

    @field_validator("amount", mode="before")
    @classmethod
    def reject_float_amount(cls, value):
        if isinstance(value, float):
            raise ValueError("amount must be a decimal string")
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
class DraftIn(BaseModel): account_id: str | None = None; thread_id: str | None = None; recipients: list[str] = []; subject: str = ""; content: str = ""
class MessageIn(BaseModel): account_id: str | None = None; thread_id: str | None = None; sender: str; recipients: list[str] = []; subject: str; body: str = ""; received_at: datetime; sync_origin: str = "import"
class FocusIn(BaseModel): task_id: str | None = None; project_id: str | None = None; started_at: datetime; mode: str = "pomodoro"
class MailAccountIn(BaseModel): provider: str = "local_import"; external_id: str | None = None
class ReminderIn(BaseModel): task_id: str; notify_at: datetime; channel: str = "in_app"; idempotency_key: str

async def owner_obj(model, item_id: str, owner_id: str, db: AsyncSession):
    item = await db.get(model, item_id)
    if not item or item.owner_id != owner_id or item.deleted_at is not None: raise HTTPException(404, detail={"code":"NOT_FOUND","message":"Resource not found"})
    return item

async def owned_ref(model, item_id: str | None, owner_id: str, db: AsyncSession, *, required: bool = False):
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
    user,_=principal; item=await owner_obj(Project,project_id,user.id,db); item.deleted_at=datetime.now(timezone.utc); item.version+=1; await db.commit(); return {"deleted":True}

@router.post("/resource-links")
async def link_resources(body: ResourceLinkIn, principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user,_=principal
    left=await owner_obj(Resource,body.from_resource_id,user.id,db); right=await owner_obj(Resource,body.to_resource_id,user.id,db)
    if left.id==right.id: raise HTTPException(409, detail={"code":"VALIDATION_ERROR","message":"Self links are not allowed"})
    item=ResourceLink(owner_id=user.id,from_resource_id=left.id,to_resource_id=right.id,relation_type=body.relation_type); db.add(item)
    try: await db.commit()
    except Exception: await db.rollback(); raise HTTPException(409, detail={"code":"DUPLICATE","message":"Link already exists"})
    return {"id":item.id}
@router.delete("/resource-links/{link_id}")
async def unlink_resources(link_id: str, principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(ResourceLink,link_id,user.id,db); item.deleted_at=datetime.now(timezone.utc); item.version+=1; await db.commit(); return {"deleted":True}

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
async def update_note(item_id:str, body:NoteIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,device=principal; item=await owner_obj(Note,item_id,user.id,db)
    await owned_ref(Project, body.project_id, user.id, db)
    await owned_ref(Note, body.parent_id, user.id, db)
    if body.markdown_body != item.markdown_body:
        db.add(NoteRevision(note_id=item.id,base_version=item.version,revision_no=item.version+1,body=body.markdown_body,source_device_id=device.id if device else None))
    for k,v in body.model_dump().items(): setattr(item,k,v)
    item.version+=1; await db.commit(); await db.refresh(item); return item
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
    user,_=principal; item=await owner_obj(Note,item_id,user.id,db); item.deleted_at=datetime.now(timezone.utc); item.version+=1; await db.commit(); return {"deleted":True}

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
async def update_task(item_id:str, body:TaskIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(Task,item_id,user.id,db)
    await owned_ref(Project, body.project_id, user.id, db)
    await owned_ref(Task, body.parent_task_id, user.id, db)
    for k,v in body.model_dump().items(): setattr(item,k,v)
    item.version+=1; await db.commit(); await db.refresh(item); return item
@router.delete("/tasks/{item_id}")
async def delete_task(item_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(Task,item_id,user.id,db); item.deleted_at=datetime.now(timezone.utc); item.version+=1; await db.commit(); return {"deleted":True}

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
@router.post("/calendar/events", response_model=EventOut)
async def create_event(body:EventIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    if body.ends_at<body.starts_at: raise HTTPException(422,detail={"code":"VALIDATION_ERROR","message":"ends_at must not precede starts_at"})
    user,_=principal
    await owned_ref(Project, body.project_id, user.id, db)
    await owned_ref(Task, body.linked_task_id, user.id, db)
    item=CalendarEvent(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/calendar/events/{item_id}", response_model=EventOut)
async def get_event(item_id:str, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; return await owner_obj(CalendarEvent,item_id,user.id,db)
@router.patch("/calendar/events/{item_id}")
async def update_event(item_id:str,body:EventIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(CalendarEvent,item_id,user.id,db)
    if body.ends_at<body.starts_at: raise HTTPException(422,detail={"code":"VALIDATION_ERROR","message":"ends_at must not precede starts_at"})
    await owned_ref(Project, body.project_id, user.id, db)
    await owned_ref(Task, body.linked_task_id, user.id, db)
    for k,v in body.model_dump().items(): setattr(item,k,v)
    item.version+=1; await db.commit(); return item
@router.delete("/calendar/events/{item_id}")
async def delete_event(item_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(CalendarEvent,item_id,user.id,db); item.deleted_at=datetime.now(timezone.utc); item.version+=1; await db.commit(); return {"deleted":True}

@router.post("/finance/accounts")
async def create_account(body:FinanceAccountIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; item=FinanceAccount(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/finance/accounts")
async def accounts(principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(FinanceAccount).where(FinanceAccount.owner_id==user.id,FinanceAccount.deleted_at.is_(None)))).scalars())
@router.post("/finance/categories")
async def create_category(body:FinanceCategoryIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=FinanceCategory(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/finance/categories")
async def categories(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(FinanceCategory).where(FinanceCategory.owner_id==user.id,FinanceCategory.deleted_at.is_(None)))).scalars())
@router.post("/finance/budgets")
async def create_budget(body:FinanceBudgetIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; await owned_ref(FinanceCategory, body.category_id, user.id, db)
    if body.period_end < body.period_start: raise HTTPException(422, detail={"code":"VALIDATION_ERROR","message":"period_end must not precede period_start"})
    item=FinanceBudget(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/finance/budgets")
async def budgets(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(FinanceBudget).where(FinanceBudget.owner_id==user.id,FinanceBudget.deleted_at.is_(None)))).scalars())
@router.get("/finance/transactions")
async def transactions(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(FinanceTransaction).where(FinanceTransaction.owner_id==user.id,FinanceTransaction.deleted_at.is_(None)).order_by(FinanceTransaction.occurred_at.desc()))).scalars())
@router.post("/finance/transactions")
async def create_transaction(body:TransactionIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal
    await owned_ref(FinanceAccount, body.account_id, user.id, db, required=True)
    await owned_ref(FinanceCategory, body.category_id, user.id, db)
    if body.idempotency_key:
        old=(await db.execute(select(FinanceTransaction).where(FinanceTransaction.owner_id==user.id,FinanceTransaction.idempotency_key==body.idempotency_key))).scalar_one_or_none()
        if old: return old
    item=FinanceTransaction(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item

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
    return TransferOut(transfer_id=transfer_id, debit=debit, credit=credit)

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
    user,_=principal; rows=list((await db.execute(select(FinanceTransaction).where(FinanceTransaction.owner_id==user.id,FinanceTransaction.deleted_at.is_(None)))).scalars()); total=sum((x.amount for x in rows),Decimal("0")); return {"total":str(total),"count":len(rows)}

@router.post("/focus/sessions")
async def start_focus(body:FocusIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; await owned_ref(Project, body.project_id, user.id, db); await owned_ref(Task, body.task_id, user.id, db)
    active=(await db.execute(select(FocusSession).where(FocusSession.owner_id==user.id,FocusSession.status=="active"))).scalar_one_or_none()
    if active: raise HTTPException(409,detail={"code":"TIMER_ACTIVE","message":"Only one active focus session is allowed"})
    item=FocusSession(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/focus/sessions")
async def focus_sessions(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(FocusSession).where(FocusSession.owner_id==user.id).order_by(FocusSession.started_at.desc()))).scalars())
@router.post("/focus/sessions/{item_id}/stop")
async def stop_focus(item_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await owner_obj(FocusSession,item_id,user.id,db); item.ended_at=datetime.now(timezone.utc); item.elapsed_seconds=max(item.elapsed_seconds,int((item.ended_at-item.started_at).total_seconds())); item.status="completed"; await db.commit(); return item
@router.post("/mail/messages")
async def import_message(body:MessageIn, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; await owned_ref(MailAccount, body.account_id, user.id, db)
    item=MailMessage(owner_id=user.id,**body.model_dump()); db.add(item); await db.commit(); await db.refresh(item); return item
@router.get("/mail/messages")
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
@router.get("/search")
async def search(q:str=Query(min_length=1,max_length=200), principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,_=principal; needle=f"%{q}%"; out=[]
    for model,fields,kind in [(Note,[Note.title,Note.markdown_body],"note"),(Task,[Task.title,Task.description],"task"),(MailMessage,[MailMessage.subject,MailMessage.body],"mail")]:
        rows=(await db.execute(select(model).where(model.owner_id==user.id,or_(*[x.ilike(needle) for x in fields])))).scalars()
        out += [{"kind":kind,"id":x.id,"title":getattr(x,"title",getattr(x,"subject",""))} for x in rows]
    return {"results":out}

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
    user,_=principal; item=await owner_obj(Notification,item_id,user.id,db); item.read_at=datetime.now(timezone.utc); await db.commit(); return item
