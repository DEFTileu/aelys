from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_db
from .models import AuditLog, User
from .security import current_principal

router = APIRouter(prefix="/system", tags=["system"])
_PROCESS_STARTED_AT = time.monotonic()

KNOWN_ACTIONS = frozenset(
    {
        "auth.native.login",
        "device.setup.first_owner",
        "device.setup.recovery",
        "device.register_key",
        "device.pair.approve",
        "device.pair.reject",
        "device.revoke",
        "project.grant.create",
        "project.grant.revoke",
        "project.grant.isolation_attest",
        "agent.session.stop",
    }
)
KNOWN_DECISIONS = frozenset({"allow", "deny"})
KNOWN_OUTCOMES = frozenset({"created", "enrolled", "approved", "rejected", "revoked", "validated", "requested"})


class SystemStatus(BaseModel):
    checked_at: datetime
    api: Literal["ok"]
    database: Literal["ok"]
    uptime_seconds: float


class SystemEvent(BaseModel):
    id: str
    action: str
    decision: str
    outcome: str
    created_at: datetime


class SystemEvents(BaseModel):
    items: list[SystemEvent]


def _safe_value(value: str, allowed: frozenset[str]) -> str:
    return value if value in allowed else "other"


@router.get("/status", response_model=SystemStatus)
async def system_status(
    response: Response,
    principal=Depends(current_principal),
    db: AsyncSession = Depends(get_db),
) -> SystemStatus:
    response.headers["Cache-Control"] = "no-store"
    owner, _ = principal
    # A fresh owner lookup proves this request's database is reachable before
    # reporting either health field as healthy.
    await db.scalar(select(User.id).where(User.id == owner.id))
    return SystemStatus(
        checked_at=datetime.now(UTC),
        api="ok",
        database="ok",
        uptime_seconds=max(0.0, time.monotonic() - _PROCESS_STARTED_AT),
    )


@router.get("/events", response_model=SystemEvents)
async def system_events(
    response: Response,
    limit: int = Query(default=50, ge=1, le=100),
    principal=Depends(current_principal),
    db: AsyncSession = Depends(get_db),
) -> SystemEvents:
    response.headers["Cache-Control"] = "no-store"
    owner, _ = principal
    rows = (
        await db.execute(
            select(AuditLog.id, AuditLog.action, AuditLog.decision, AuditLog.outcome, AuditLog.created_at)
            .where(AuditLog.owner_id == owner.id)
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
            .limit(limit)
        )
    ).all()
    return SystemEvents(
        items=[
            SystemEvent(
                id=row.id,
                action=_safe_value(row.action, KNOWN_ACTIONS),
                decision=_safe_value(row.decision, KNOWN_DECISIONS),
                outcome=_safe_value(row.outcome, KNOWN_OUTCOMES),
                created_at=(
                    row.created_at.replace(tzinfo=UTC)
                    if row.created_at.tzinfo is None
                    else row.created_at.astimezone(UTC)
                ),
            )
            for row in rows
        ]
    )
