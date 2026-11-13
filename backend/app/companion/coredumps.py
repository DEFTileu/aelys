"""Crash dumps: a board uploads its core dump after a crash, the owner lists and downloads them."""
from __future__ import annotations

import hashlib
import re
from datetime import datetime

from app.companion.api import _companion_device
from app.companion.commands import target_board
from app.companion.firmware import read_capped
from app.companion.ota_models import CompanionCoredump
from app.core.db import get_db
from app.core.models import Device, User
from app.core.security import current_principal
from fastapi import APIRouter, Depends, Header, HTTPException, Response
from fastapi import Request as HttpRequest
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/companion", tags=["companion"])

MAX_DUMP_BYTES = 64 * 1024  # the coredump partition is 0x10000
KEEP = 5
_SEMVER = re.compile(r"[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}")
_SHA256 = re.compile(r"[0-9a-fA-F]{64}")


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


class DumpId(BaseModel):
    id: str


class DumpOut(BaseModel):
    id: str
    fw_version: str
    elf_sha256: str | None
    size: int
    created_at: datetime


@router.post("/coredumps", response_model=DumpId, status_code=201)
async def upload_coredump(request: HttpRequest, response: Response, fw_version: str = Header(default="", alias="X-Fw-Version"),
                          elf_sha256: str | None = Header(default=None, alias="X-Elf-Sha256"),
                          principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, board = _companion_device(principal)
    if not _SEMVER.fullmatch(fw_version) or (elf_sha256 is not None and not _SHA256.fullmatch(elf_sha256)):
        raise _error(422, "VALIDATION_ERROR", "X-Fw-Version must be MAJOR.MINOR.PATCH and X-Elf-Sha256 64 hex digits")
    data = await read_capped(request, MAX_DUMP_BYTES, "COREDUMP_TOO_LARGE")
    if not data:
        raise _error(422, "VALIDATION_ERROR", "Empty core dump")
    digest = hashlib.sha256(data).hexdigest()
    same = select(CompanionCoredump.id).where(CompanionCoredump.device_id == board.id, CompanionCoredump.sha256 == digest)
    existing = (await db.execute(same)).scalar_one_or_none()
    if existing is None:
        row = CompanionCoredump(owner_id=user.id, device_id=board.id, fw_version=fw_version, elf_sha256=elf_sha256 and elf_sha256.lower(),
                                sha256=digest, size=len(data), data=data)
        db.add(row)
        try:
            await db.flush()
        except IntegrityError:  # an identical upload won the race
            await db.rollback()
            existing = (await db.execute(same)).scalar_one()
    if existing is not None:
        response.status_code = 200
        return DumpId(id=existing)
    stale = (await db.execute(select(CompanionCoredump.id).where(CompanionCoredump.device_id == board.id)
                              .order_by(CompanionCoredump.created_at.desc()).offset(KEEP))).scalars().all()
    if stale:
        await db.execute(delete(CompanionCoredump).where(CompanionCoredump.id.in_(stale)))
    await db.commit()
    return DumpId(id=row.id)


@router.get("/devices/{device_id}/coredumps", response_model=list[DumpOut])
async def list_coredumps(target: tuple[User, Device, Device] = Depends(target_board), db: AsyncSession = Depends(get_db)):
    columns = (CompanionCoredump.id, CompanionCoredump.fw_version, CompanionCoredump.elf_sha256, CompanionCoredump.size, CompanionCoredump.created_at)
    rows = (await db.execute(select(*columns).where(CompanionCoredump.device_id == target[2].id).order_by(CompanionCoredump.created_at.desc()))).all()
    return [DumpOut(**row._asdict()) for row in rows]


@router.get("/devices/{device_id}/coredumps/{dump_id}")
async def download_coredump(dump_id: str, target: tuple[User, Device, Device] = Depends(target_board), db: AsyncSession = Depends(get_db)):
    data = (await db.execute(select(CompanionCoredump.data).where(CompanionCoredump.id == dump_id, CompanionCoredump.device_id == target[2].id))).scalar_one_or_none()
    if data is None:
        raise _error(404, "NOT_FOUND", "No such crash dump")
    return Response(content=data, media_type="application/octet-stream")
