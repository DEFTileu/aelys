from __future__ import annotations

from datetime import UTC, date, datetime

from app.core.db import get_db
from app.core.models import User
from app.core.security import current_principal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from .config import FocusConfig, FocusLimitError, FocusState, apply_edit, promote
from .unlock_state import AI_GRANTS_LEFT, REQUESTS_LEFT, day_unlocked

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
    return FocusStateOut(day_unlocked=await day_unlocked(db, owner_id, day), ai_grants_left=AI_GRANTS_LEFT, requests_left=REQUESTS_LEFT, config=config)


@router.put("/config", response_model=FocusState)
async def put_config(body: FocusConfigBody, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _, state = await _promoted(db, principal[0].id, body.day)
    try:
        edited = apply_edit(state, body.config, body.day)
    except FocusLimitError as exc:
        raise HTTPException(422, detail={"code": "FOCUS_LIMIT", "message": str(exc)}) from exc
    return await _save(db, user, edited)
