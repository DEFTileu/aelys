from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from typing import Annotated

from app.core.db import get_db
from app.core.models import FocusUnlockRequest, User
from app.core.security import current_principal
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, StringConstraints, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import FocusConfig, FocusLimitError, FocusState, apply_edit, promote
from .unlock import decide
from .unlock_state import ai_left, day_unlocked

router = APIRouter(prefix="/focus", tags=["focus"])


class FocusConfigBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    config: FocusConfig
    day: date  # the owner's local date


def _check_day(day: date) -> None:
    """The client sends its local date, so it could skip the delay by lying; any real timezone is within a day of UTC."""
    if abs((day - datetime.now(UTC).date()).days) > 1:
        raise HTTPException(422, detail={"code": "BAD_DAY", "message": "day must be today's date"})


async def _promoted(db: AsyncSession, owner_id: str, day: date) -> tuple[User, FocusState, FocusState]:
    _check_day(day)
    user = await db.get(User, owner_id)
    assert user is not None
    try:
        stored = FocusState.model_validate((user.settings_json or {}).get("focus") or {})
    except ValidationError:  # a corrupt stored value must not brick the endpoint
        stored = FocusState()
    return user, stored, promote(stored, day)


async def _save(db: AsyncSession, user: User, state: FocusState) -> FocusState:
    user.settings_json = {**(user.settings_json or {}), "focus": state.model_dump(mode="json")}
    await db.commit()
    return state


async def _current(db: AsyncSession, owner_id: str, day: date) -> FocusState:
    user, stored, state = await _promoted(db, owner_id, day)
    return state if state == stored else await _save(db, user, state)


class FocusStateOut(BaseModel):
    day_unlocked: bool
    ai_grants_left: int
    requests_left: int
    config: FocusState


@router.get("/config", response_model=FocusState)
async def get_config(day: date, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    return await _current(db, principal[0].id, day)


@router.get("/state", response_model=FocusStateOut)
async def get_state(day: date, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    owner_id = principal[0].id
    config = await _current(db, owner_id, day)
    grants_left, requests_left = await ai_left(db, owner_id, day)
    return FocusStateOut(day_unlocked=await day_unlocked(db, owner_id, day), ai_grants_left=grants_left, requests_left=requests_left, config=config)


@router.put("/config", response_model=FocusState)
async def put_config(body: FocusConfigBody, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _, state = await _promoted(db, principal[0].id, body.day)
    try:
        edited = apply_edit(state, body.config, body.day)
    except FocusLimitError as exc:
        raise HTTPException(422, detail={"code": "FOCUS_LIMIT", "message": str(exc)}) from exc
    return await _save(db, user, edited)


class UnlockRequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    day: date  # the owner's local date
    app_id: str
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]


class UnlockResultOut(BaseModel):
    granted: bool
    minutes: int
    message: str
    ai_grants_left: int
    requests_left: int


class UnlockRequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    day: date
    app_id: str
    reason: str
    granted: bool
    minutes: int
    message: str
    created_at: datetime


# shortcut: one lock for the single-user, single-process server so concurrent requests cannot both pass the cap check; use a DB-level reservation if this ever runs multi-process.
_unlock_lock = asyncio.Lock()


@router.post("/unlock-request", response_model=UnlockResultOut)
async def unlock_request(body: UnlockRequestBody, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    owner_id = principal[0].id
    effective = (await _current(db, owner_id, body.day)).effective
    if body.app_id not in {a.id for a in effective.apps}:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "That app is not in the focus list"})
    async with _unlock_lock:
        store = (await ai_left(db, owner_id, body.day))[1] > 0  # requests past the cap are refused but not stored, so rows stay bounded
        decision = await decide(db, owner_id, body.day, body.app_id, body.reason)
        if store:
            db.add(FocusUnlockRequest(owner_id=owner_id, day=body.day, app_id=body.app_id, reason=body.reason, granted=decision.granted, minutes=decision.minutes, message=decision.message, ai_run_id=decision.ai_run_id))
            await db.commit()
        grants_left, requests_left = await ai_left(db, owner_id, body.day)
    return UnlockResultOut(granted=decision.granted, minutes=decision.minutes, message=decision.message, ai_grants_left=grants_left, requests_left=requests_left)


@router.get("/requests", response_model=list[UnlockRequestOut])
async def list_requests(limit: int = Query(50, ge=1, le=200), principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    rows = await db.execute(select(FocusUnlockRequest).where(FocusUnlockRequest.owner_id == principal[0].id, FocusUnlockRequest.deleted_at.is_(None)).order_by(FocusUnlockRequest.created_at.desc(), FocusUnlockRequest.id.desc()).limit(limit))
    return rows.scalars().all()
