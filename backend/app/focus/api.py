from __future__ import annotations

from datetime import date

from app.core.db import get_db
from app.core.models import User
from app.core.security import current_principal
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from .config import FocusConfig, FocusState, apply_edit, promote

router = APIRouter(prefix="/focus", tags=["focus"])


class FocusConfigBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    config: FocusConfig
    day: date  # the owner's local date


async def _promoted(db: AsyncSession, owner_id: str, day: date) -> tuple[User, FocusState]:
    user = await db.get(User, owner_id)
    assert user is not None
    return user, promote(FocusState.model_validate((user.settings_json or {}).get("focus") or {}), day)


async def _save(db: AsyncSession, user: User, state: FocusState) -> FocusState:
    user.settings_json = {**(user.settings_json or {}), "focus": state.model_dump(mode="json")}
    await db.commit()
    return state


@router.get("/config", response_model=FocusState)
async def get_config(day: date, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, state = await _promoted(db, principal[0].id, day)
    return await _save(db, user, state)


@router.put("/config", response_model=FocusState)
async def put_config(body: FocusConfigBody, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, state = await _promoted(db, principal[0].id, body.day)
    return await _save(db, user, apply_edit(state, body.config, body.day))
