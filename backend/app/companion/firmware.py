"""Signed firmware releases: the owner's Mac uploads them, a paired board downloads the newest one."""
from __future__ import annotations

import hashlib
import re

from app.companion.ota_models import CompanionFirmware
from app.core.db import get_db
from app.core.device_auth import trusted_device
from app.core.models import Device, User
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(tags=["companion"])

MAX_IMAGE_BYTES = 4 * 1024 * 1024  # ota_0 / ota_1 are 0x400000
KEEP = 3
_SEMVER = re.compile(r"[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}")


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def parse_semver(v: str) -> tuple[int, int, int]:
    if not _SEMVER.fullmatch(v):
        raise _error(422, "FIRMWARE_INVALID", "Version must be MAJOR.MINOR.PATCH")
    major, minor, patch = (int(part) for part in v.split("."))
    return major, minor, patch


def _c_string(raw: bytes) -> str:
    return raw.split(b"\0", 1)[0].decode("ascii", "replace")


def check_image(data: bytes, version: str) -> None:
    """Shape check only (the board and the bootloader verify the signature itself): app image, right version and project, signed."""
    if len(data) < 4096 + 112 or data[0] != 0xE9 or int.from_bytes(data[32:36], "little") != 0xABCD5432:
        raise _error(422, "FIRMWARE_INVALID", "Not an ESP-IDF app image")
    if _c_string(data[48:80]) != version or _c_string(data[80:112]) != "companion":
        raise _error(422, "FIRMWARE_INVALID", "Image version or project does not match")
    if len(data) % 4096 or data[-4096] != 0xE7 or data[-4095] != 0x02:
        raise _error(422, "FIRMWARE_UNSIGNED", "Image carries no signature block")


async def read_capped(request: Request, cap: int, code: str) -> bytes:
    """Read the body but stop pulling from the socket the moment it passes `cap`."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > cap:
        raise _error(413, code, f"Body is larger than {cap} bytes")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > cap:
            raise _error(413, code, f"Body is larger than {cap} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


async def _newest_first(db: AsyncSession, owner_id: str) -> list[tuple[str, str]]:
    rows = (await db.execute(select(CompanionFirmware.id, CompanionFirmware.version).where(CompanionFirmware.owner_id == owner_id))).all()
    return sorted(((row.id, row.version) for row in rows), key=lambda row: parse_semver(row[1]), reverse=True)


async def latest_release(db: AsyncSession, owner_id: str) -> CompanionFirmware | None:
    """Highest version wins, not the newest upload: a late 0.9.0 must not roll the fleet back."""
    ordered = await _newest_first(db, owner_id)
    return await db.get(CompanionFirmware, ordered[0][0]) if ordered else None


class ReleaseOut(BaseModel):
    version: str
    sha256: str
    size: int
    min_version: str


class ReleaseMetaOut(ReleaseOut):
    url: str


def _out(row: CompanionFirmware) -> ReleaseOut:
    return ReleaseOut(version=row.version, sha256=row.sha256, size=row.size, min_version=row.min_version)


async def owner_uploader(principal: tuple[User, Device] = Depends(trusted_device)) -> tuple[User, Device]:
    if principal[1].platform == "companion":
        raise _error(403, "DEVICE_SCOPE_DENIED", "This device may not use this endpoint")
    return principal


@router.put("/companion/firmware/{version}", response_model=ReleaseOut, status_code=201)
async def upload_firmware(version: str, request: Request, response: Response, min_version: str = Query(),
                          sha256: str = Header(default="", alias="X-Content-Sha256"),
                          principal: tuple[User, Device] = Depends(owner_uploader), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    if parse_semver(min_version) > parse_semver(version):
        raise _error(422, "FIRMWARE_INVALID", "min_version is above version")
    data = await read_capped(request, MAX_IMAGE_BYTES, "FIRMWARE_TOO_LARGE")
    digest = hashlib.sha256(data).hexdigest()
    if sha256.lower() != digest:
        raise _error(422, "FIRMWARE_HASH_MISMATCH", "X-Content-Sha256 does not match the body")
    check_image(data, version)
    existing = (await db.execute(select(CompanionFirmware).where(CompanionFirmware.owner_id == user.id, CompanionFirmware.version == version))).scalar_one_or_none()
    if existing:
        if existing.sha256 != digest:
            raise _error(409, "FIRMWARE_EXISTS", "This version is already released with other contents")
        response.status_code = 200
        return _out(existing)
    row = CompanionFirmware(owner_id=user.id, version=version, min_version=min_version, sha256=digest, size=len(data), data=data)
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:  # a concurrent upload of the same version won
        await db.rollback()
        raise _error(409, "FIRMWARE_EXISTS", "This version is already released") from None
    stale = [row_id for row_id, _ in (await _newest_first(db, user.id))[KEEP:]]
    if stale:
        await db.execute(delete(CompanionFirmware).where(CompanionFirmware.id.in_(stale)))
    await db.commit()
    return _out(row)


@router.get("/devices/{device_id}/firmware", response_model=ReleaseMetaOut)
async def firmware_for_device(device_id: str, principal: tuple[User, Device] = Depends(trusted_device), db: AsyncSession = Depends(get_db)):
    user, caller = principal
    if caller.platform == "companion":
        if caller.id != device_id:
            raise _error(403, "DEVICE_SCOPE_DENIED", "A board may read only its own firmware")
    else:
        board = await db.get(Device, device_id)
        if board is None or board.owner_id != user.id or board.platform != "companion" or board.revoked_at:
            raise _error(404, "NOT_FOUND", "Companion not found")
    release = await latest_release(db, user.id)
    if release is None:
        raise _error(404, "FIRMWARE_NONE", "No firmware has been released")
    return ReleaseMetaOut(**_out(release).model_dump(), url=f"/api/v1/companion/firmware/{release.version}/image")


@router.get("/companion/firmware/{version}/image")
async def firmware_image(version: str, principal: tuple[User, Device] = Depends(trusted_device), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    row = (await db.execute(select(CompanionFirmware).where(CompanionFirmware.owner_id == user.id, CompanionFirmware.version == version))).scalar_one_or_none()
    if row is None:
        raise _error(404, "FIRMWARE_NONE", "No such firmware release")
    return Response(content=row.data, media_type="application/octet-stream")
