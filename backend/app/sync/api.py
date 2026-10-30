from __future__ import annotations

import json
import uuid
from datetime import datetime
from enum import Enum

from app.core.db import get_db
from app.core.models import ClientOperation, DeviceSyncCursor, SyncChange, SyncRecord
from app.core.security import current_principal
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from .cursor import CursorCodec
from .models import SyncErrorCode
from .validation import SyncException, validate_patch

router=APIRouter()
ALLOWED={"project","note","task","event","finance_transaction","focus_session","mail_message","mail_draft","ai_message"}
def _codec() -> CursorCodec:
    from app.core.config import get_settings
    secret=get_settings().secret_key.encode()
    return CursorCodec(secret if len(secret)>=32 else (secret + b"0"*32)[:32])
class Action(str,Enum): create="create"; update="update"; delete="delete"
class Operation(BaseModel):
    operation_id:str=Field(default_factory=lambda:str(uuid.uuid4())); device_id:str; resource_kind:str; resource_id:str; action:Action; base_version:int=0; client_timestamp:datetime|None=None; patch:dict={}
    @model_validator(mode="after")
    def validate_payload(self):
        if self.resource_kind not in ALLOWED: raise ValueError("resource_kind is not syncable")
        try:
            validate_patch(self.patch)
        except SyncException as exc:
            raise ValueError(exc.message) from exc
        return self
class Push(BaseModel): device_id:str; operations:list[Operation]=Field(max_length=200)
class Ack(BaseModel): device_id:str; cursor:str=Field(min_length=1,max_length=512)
class Receipt(BaseModel): operation_id:str; status:str; version:int|None=None; cursor:str|None=None; conflict:dict|None=None


def _sync_error(exc: SyncException) -> HTTPException:
    """Map mounted sync failures to the documented API error envelope."""
    return HTTPException(
        status_code=exc.status_code,
        detail={"error": {"code": exc.code.value, "message": exc.message, "details": exc.details}},
    )


async def _compaction_watermark(db: AsyncSession, owner_id: str) -> int:
    """Read the optional migration-backed owner watermark.

    Older local databases are allowed to run before migration 0011. They have
    no compaction marker and therefore cannot report a stale cursor yet.
    """
    if db.get_bind().dialect.name != "postgresql":
        return 0
    try:
        value = await db.execute(
            text(
                "SELECT watermark FROM sync_compaction_watermarks "
                "WHERE owner_id = :owner_id"
            ),
            {"owner_id": owner_id},
        )
    except ProgrammingError:
        # A mounted test database may be created directly from Base.metadata,
        # without running Alembic. Do not turn that compatibility case into a
        # 500 or weaken the auth/privacy checks around sync.
        await db.rollback()
        return 0
    return int(value.scalar_one_or_none() or 0)


def _bootstrap_key(scope: str | None, resource_kind: str, resource_id: str) -> str:
    """Return the stable ordering key and scope carried in an opaque token."""
    return json.dumps([scope, resource_kind, resource_id], separators=(",", ":"))


def _bootstrap_key_parts(value: str, scope: str | None) -> tuple[str, str]:
    try:
        token_scope, resource_kind, resource_id = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        token_scope = resource_kind = resource_id = None
    if (
        token_scope != scope
        or not isinstance(resource_kind, str)
        or not isinstance(resource_id, str)
        or not resource_kind
        or not resource_id
    ):
        raise SyncException(
            SyncErrorCode.VALIDATION_ERROR,
            "Invalid bootstrap page boundary",
            {},
            422,
        )
    return resource_kind, resource_id


async def _bootstrap_page(
    db: AsyncSession,
    owner_id: str,
    snapshot_seq: int,
    after_key: str | None,
    scope: str | None,
    limit: int,
):
    """Read the last visible change for each resource at a fixed snapshot."""
    latest_seq = (
        select(
            SyncChange.resource_kind.label("resource_kind"),
            SyncChange.resource_id.label("resource_id"),
            func.max(SyncChange.seq).label("seq"),
        )
        .where(
            SyncChange.owner_id == owner_id,
            SyncChange.seq <= snapshot_seq,
            *([SyncChange.resource_kind == scope] if scope else []),
        )
        .group_by(SyncChange.resource_kind, SyncChange.resource_id)
        .subquery()
    )
    boundary = []
    if after_key:
        after_kind, after_id = _bootstrap_key_parts(after_key, scope)
        boundary.append(
            or_(
                SyncChange.resource_kind > after_kind,
                and_(
                    SyncChange.resource_kind == after_kind,
                    SyncChange.resource_id > after_id,
                ),
            )
        )
    rows = (
        await db.execute(
            select(SyncChange)
            .join(
                latest_seq,
                and_(
                    SyncChange.resource_kind == latest_seq.c.resource_kind,
                    SyncChange.resource_id == latest_seq.c.resource_id,
                    SyncChange.seq == latest_seq.c.seq,
                ),
            )
            .where(
                SyncChange.owner_id == owner_id,
                *boundary,
            )
            .order_by(SyncChange.resource_kind, SyncChange.resource_id)
            .limit(limit + 1)
        )
    ).scalars().all()
    has_more = len(rows) > limit
    page = rows[:limit]
    next_key = _bootstrap_key(scope, page[-1].resource_kind, page[-1].resource_id) if has_more else None
    return page, has_more, next_key

@router.post("/sync/push")
async def push(body:Push, principal=Depends(current_principal), db:AsyncSession=Depends(get_db)):
    user,device=principal
    bind=db.get_bind()
    if bind.dialect.name == "postgresql":
        # Serialize all pushes for one owner so allocation order and commit
        # order cannot diverge for the cursor protocol.
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"), {"lock_key":f"sync-owner:{user.id}"})
    if not device or device.id!=body.device_id: raise HTTPException(403,detail={"code":"FORBIDDEN","message":"Device-bound sync credential required"})
    receipts=[]
    for op in body.operations:
        old=await db.get(ClientOperation,op.operation_id)
        if old:
            if old.owner_id != user.id or old.device_id != body.device_id:
                raise HTTPException(403,detail={"code":"FORBIDDEN","message":"Operation is bound to another owner or device"})
            receipts.append(Receipt(operation_id=op.operation_id,status=old.result_status,version=old.applied_version,cursor=_codec().encode(kind="pull",owner_id=user.id,commit_seq=old.applied_seq or 0) if old.applied_seq else None,conflict=old.response_json.get("conflict"))); continue
        if op.resource_kind not in ALLOWED: raise HTTPException(422,detail={"code":"VALIDATION_ERROR","message":"Resource is not syncable"})
        record=await db.get(SyncRecord,(user.id,op.resource_kind,op.resource_id))
        current_version=record.version if record else 0
        if op.action.value == "create" and record and not record.deleted_at:
            conflict={"code":"ALREADY_EXISTS","server_version":current_version}
            db.add(ClientOperation(operation_id=op.operation_id,owner_id=user.id,device_id=body.device_id,resource_id=op.resource_id,result_status="conflict",applied_version=current_version,response_json={"conflict":conflict})); receipts.append(Receipt(operation_id=op.operation_id,status="conflict",version=current_version,conflict=conflict)); continue
        if op.action.value != "create" and (not record or op.base_version != current_version):
            conflict={"code":"VERSION_CONFLICT","server_version":current_version}
            if op.resource_kind=="note" and op.action.value=="update": conflict["branches"]=[{"branch":"server","payload":record.payload if record else {}},{"branch":"client","payload":op.patch,"base_version":op.base_version}]
            db.add(ClientOperation(operation_id=op.operation_id,owner_id=user.id,device_id=body.device_id,resource_id=op.resource_id,result_status="conflict",applied_version=current_version,response_json={"conflict":conflict})); receipts.append(Receipt(operation_id=op.operation_id,status="conflict",version=current_version,conflict=conflict)); continue
        version=current_version+1
        payload=dict(record.payload) if record else {}
        payload.update(op.patch)
        if op.action.value=="delete": payload={};
        if record: record.version=version; record.payload=payload; record.deleted_at=__import__("app.core.models",fromlist=["now"]).now() if op.action.value=="delete" else None
        else: record=SyncRecord(owner_id=user.id,resource_kind=op.resource_kind,resource_id=op.resource_id,version=version,payload=payload); db.add(record)
        change=SyncChange(owner_id=user.id,resource_kind=op.resource_kind,resource_id=op.resource_id,version=version,operation=op.action.value,payload=payload)
        db.add(change); await db.flush()
        receipt=ClientOperation(operation_id=op.operation_id,owner_id=user.id,device_id=body.device_id,resource_id=op.resource_id,result_status="applied",applied_version=version,applied_seq=change.seq,response_json={"version":version})
        db.add(receipt); receipts.append(Receipt(operation_id=op.operation_id,status="applied",version=version,cursor=_codec().encode(kind="pull",owner_id=user.id,commit_seq=change.seq)))
    latest=(await db.execute(select(SyncChange.seq).where(SyncChange.owner_id==user.id).order_by(SyncChange.seq.desc()).limit(1))).scalar_one_or_none() or 0
    await db.commit()
    return {"results":[x.model_dump() for x in receipts],"server_cursor":_codec().encode(kind="pull",owner_id=user.id,commit_seq=latest)}

@router.get("/sync/pull")
async def pull(cursor:str=Query(default="0"),limit:int=Query(default=200,ge=1,le=500),principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,device=principal
    if not device: raise HTTPException(403,detail={"code":"FORBIDDEN","message":"Device-bound sync credential required"})
    try:
        decoded=_codec().decode(cursor,owner_id=user.id,expected_kind="pull") if cursor!="0" else None
        after=decoded.commit_seq if decoded else 0
        latest=(await db.execute(select(SyncChange.seq).where(SyncChange.owner_id==user.id).order_by(SyncChange.seq.desc()).limit(1))).scalar_one_or_none() or 0
        if after > latest:
            raise SyncException(SyncErrorCode.VALIDATION_ERROR,"Cannot pull from a future cursor",{},422)
        watermark=await _compaction_watermark(db,user.id)
        if after < watermark:
            raise SyncException(SyncErrorCode.SYNC_RESET_REQUIRED,"The sync cursor is too old; bootstrap is required",{"compaction_watermark":watermark,"reset":"bootstrap"},409)
        changes=list((await db.execute(select(SyncChange).where(SyncChange.owner_id==user.id,SyncChange.seq>after).order_by(SyncChange.seq).limit(limit))).scalars()); next_cursor=_codec().encode(kind="pull",owner_id=user.id,commit_seq=changes[-1].seq if changes else after)
        return {"changes":[{"seq":x.seq,"resource_kind":x.resource_kind,"resource_id":x.resource_id,"version":x.version,"operation":x.operation,"payload":x.payload} for x in changes],"next_cursor":next_cursor,"has_more":len(changes)==limit}
    except SyncException as exc:
        raise _sync_error(exc) from exc
@router.get("/sync/status")
async def status(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,device=principal
    if not device: raise HTTPException(403,detail={"code":"FORBIDDEN","message":"Device-bound sync credential required"})
    latest=(await db.execute(select(SyncChange.seq).where(SyncChange.owner_id==user.id).order_by(SyncChange.seq.desc()).limit(1))).scalar_one_or_none() or 0
    ack=(await db.get(DeviceSyncCursor,(user.id,device.id)))
    ack_seq=min(ack.last_ack_seq,latest) if ack else 0
    return {"latest_cursor":_codec().encode(kind="pull",owner_id=user.id,commit_seq=latest),"acknowledged_cursor":_codec().encode(kind="pull",owner_id=user.id,commit_seq=ack_seq),"acknowledged_seq":ack_seq,"compaction_watermark":await _compaction_watermark(db,user.id)}

@router.post("/sync/ack")
async def acknowledge(body:Ack,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,device=principal
    if not device or device.id!=body.device_id:
        raise HTTPException(403,detail={"code":"FORBIDDEN","message":"Device-bound sync credential required"})
    try:
        decoded=_codec().decode(body.cursor,owner_id=user.id,expected_kind="pull") if body.cursor!="0" else None
        acknowledged=decoded.commit_seq if decoded else 0
        latest=(await db.execute(select(SyncChange.seq).where(SyncChange.owner_id==user.id).order_by(SyncChange.seq.desc()).limit(1))).scalar_one_or_none() or 0
        if acknowledged>latest:
            raise SyncException(SyncErrorCode.VALIDATION_ERROR,"Cannot acknowledge a future cursor",{},422)
        item=await db.get(DeviceSyncCursor,(user.id,device.id))
        if item is None:
            item=DeviceSyncCursor(owner_id=user.id,device_id=device.id,last_ack_seq=acknowledged)
            db.add(item)
        else:
            item.last_ack_seq=max(item.last_ack_seq,acknowledged)
        await db.commit()
        ack_seq=item.last_ack_seq
        return {"device_id":device.id,"acknowledged_seq":ack_seq,"acknowledged_cursor":_codec().encode(kind="pull",owner_id=user.id,commit_seq=ack_seq),"compaction_watermark":await _compaction_watermark(db,user.id)}
    except SyncException as exc:
        raise _sync_error(exc) from exc

@router.get("/sync/bootstrap")
async def bootstrap(scope:str|None=Query(default=None),page_token:str|None=Query(default=None),limit:int=Query(default=200,ge=1,le=500),principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,device=principal
    if not device: raise HTTPException(403,detail={"code":"FORBIDDEN","message":"Device-bound sync credential required"})
    owner_id = user.id
    try:
        if db.get_bind().dialect.name == "postgresql":
            await db.rollback()
            await db.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        decoded=_codec().decode(page_token,owner_id=owner_id,expected_kind="bootstrap") if page_token else None
        snapshot=decoded.snapshot_seq if decoded and decoded.snapshot_seq is not None else None
        if snapshot is None:
            snapshot=(await db.execute(select(SyncChange.seq).where(SyncChange.owner_id==owner_id).order_by(SyncChange.seq.desc()).limit(1))).scalar_one_or_none() or 0
        latest=(await db.execute(select(SyncChange.seq).where(SyncChange.owner_id==owner_id).order_by(SyncChange.seq.desc()).limit(1))).scalar_one_or_none() or 0
        if snapshot > latest:
            raise SyncException(SyncErrorCode.VALIDATION_ERROR,"Bootstrap token refers to a future snapshot",{},422)
        after_key=decoded.after_resource_id if decoded else None
        rows,has_more,next_key=await _bootstrap_page(db,owner_id,snapshot,after_key,scope,limit)
        resources=[{"resource_kind":x.resource_kind,"resource_id":x.resource_id,"version":x.version,"payload":x.payload,"deleted":x.operation=="delete"} for x in rows]
        next_page_token=(_codec().encode(kind="bootstrap",owner_id=owner_id,commit_seq=snapshot,snapshot_seq=snapshot,after_resource_id=next_key) if next_key else None)
        pull_cursor=_codec().encode(kind="pull",owner_id=owner_id,commit_seq=snapshot)
        return {"snapshot_watermark":pull_cursor,"cursor":pull_cursor,"resources":resources,"next_page_token":next_page_token,"has_more":has_more}
    except SyncException as exc:
        raise _sync_error(exc) from exc
