from __future__ import annotations

from datetime import UTC, datetime

from app.companion.actions import ActionIn, ActionResult, run_action
from app.companion.snapshot import CompanionSnapshot, build_snapshot
from app.core.db import get_db
from app.core.security import current_principal
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/companion", tags=["companion"])


def _companion_device(principal):
    user, device = principal
    if device is None or device.platform != "companion":
        raise HTTPException(403, detail={"code": "COMPANION_ONLY", "message": "Only a paired companion may use the board endpoints"})
    return user, device


@router.get("/snapshot", response_model=CompanionSnapshot)
async def get_snapshot(principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = _companion_device(principal)
    return await build_snapshot(db, user.id, datetime.now(UTC))


@router.post("/actions", response_model=ActionResult)
async def post_action(body: ActionIn, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, device = _companion_device(principal)
    return await run_action(db, user.id, device, body)
