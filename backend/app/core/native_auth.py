"""Cookie-free sessions for the bounded native transport, never the WebView.

Device association is not hardware proof of possession. Tokens are bearer secrets
and belong in the native OS secret store. Browser cookie policy stays separate.
"""
from __future__ import annotations

import secrets
from datetime import UTC, timedelta
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .api import lock_owner_initialization
from .config import get_settings
from .db import get_db
from .models import AuditLog, AuthSession, Device, User, now
from .security import (
    create_token,
    decode_refresh_token,
    hash_password,
    token_hash,
    verify_password,
)


async def native_request(request: Request) -> None:
    # Headers are a browser boundary, not native-client identity. Owner credentials
    # and the server-side session/device checks below grant identity.
    if any(name in request.headers for name in ("origin", "sec-fetch-site", "sec-fetch-mode")):
        raise HTTPException(403, detail={"code": "NATIVE_TRANSPORT_REQUIRED", "message": "Use the native session transport"})


router = APIRouter(prefix="/auth/native", tags=["native-auth"], dependencies=[Depends(native_request)])


class NativeLogin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=8, max_length=1024)
    platform: Literal["macos", "android"]
    display_name: str = Field(min_length=1, max_length=200)


class NativeRefresh(BaseModel):
    model_config = ConfigDict(extra="forbid")
    refresh_token: str = Field(min_length=1, max_length=4096)


class NativeStatus(BaseModel):
    initialized: bool


class NativeSession(BaseModel):
    access_token: str
    refresh_token: str
    device_id: str
    owner_id: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


def denied() -> HTTPException:
    return HTTPException(401, detail={"code": "UNAUTHORIZED", "message": "Sign in to Aelys again"})


def session_response(owner_id: str, device_id: str, session_id: str, refresh_token: str) -> NativeSession:
    lifetime = get_settings().access_token_minutes * 60
    return NativeSession(
        access_token=create_token(owner_id, "access", lifetime, device_id, session_id),
        refresh_token=refresh_token, device_id=device_id, owner_id=owner_id, expires_in=lifetime,
    )


async def start_session(user: User, body: NativeLogin, db: AsyncSession) -> NativeSession:
    # Explicit IDs and flush preserve the FK association on SQLite and PostgreSQL.
    device = Device(id=str(uuid4()), owner_id=user.id, platform=body.platform,
                    display_name=body.display_name, credential_hash=hash_password(secrets.token_urlsafe(32)))
    db.add(device)
    await db.flush()
    session_id = secrets.token_urlsafe(24)
    lifetime = get_settings().refresh_token_days * 86400
    refresh = create_token(user.id, "refresh", lifetime, device.id, session_id)
    db.add(AuthSession(id=session_id, owner_id=user.id, device_id=device.id,
                       refresh_token_hash=token_hash(refresh), expires_at=now() + timedelta(seconds=lifetime)))
    db.add(AuditLog(owner_id=user.id, action="auth.native.login", actor="owner", scope=f"device:{device.id}",
                    decision="allow", outcome="created", correlation_id=session_id, redacted_metadata={"platform": body.platform}))
    await db.commit()
    return session_response(user.id, device.id, session_id, refresh)


@router.get("/status", response_model=NativeStatus)
async def status(db: AsyncSession = Depends(get_db)) -> NativeStatus:
    return NativeStatus(initialized=(await db.execute(select(User.id).limit(1))).first() is not None)


@router.post("/login", response_model=NativeSession)
async def login(body: NativeLogin, db: AsyncSession = Depends(get_db)) -> NativeSession:
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if not user or not user.password_hash or not verify_password(body.password, user.password_hash):
        raise denied()
    return await start_session(user, body, db)


@router.post("/bootstrap", response_model=NativeSession)
async def bootstrap(body: NativeLogin, db: AsyncSession = Depends(get_db)) -> NativeSession:
    await lock_owner_initialization(db)
    if (await db.execute(select(User.id).limit(1))).first():
        raise HTTPException(409, detail={"code": "ALREADY_INITIALIZED", "message": "Owner already exists"})
    user = User(id=str(uuid4()), email=body.email, password_hash=hash_password(body.password))
    db.add(user)
    await db.flush()
    return await start_session(user, body, db)


@router.post("/refresh", response_model=NativeSession)
async def refresh(body: NativeRefresh, db: AsyncSession = Depends(get_db)) -> NativeSession:
    claims = decode_refresh_token(body.refresh_token)
    owner_id, device_id, session_id = claims.get("sub"), claims.get("device_id"), claims.get("sid")
    if not isinstance(owner_id, str) or not owner_id or not isinstance(device_id, str) or not device_id or not isinstance(session_id, str) or not session_id:
        raise denied()
    session = (await db.execute(select(AuthSession).where(
        AuthSession.id == session_id, AuthSession.owner_id == owner_id, AuthSession.device_id == device_id,
        AuthSession.refresh_token_hash == token_hash(body.refresh_token), AuthSession.revoked_at.is_(None),
    ))).scalar_one_or_none()
    device = await db.get(Device, device_id)
    user = await db.get(User, owner_id)
    if not session or not device or not user or device.owner_id != owner_id or device.revoked_at or device.platform not in ("macos", "android"):
        raise denied()
    expires = session.expires_at.replace(tzinfo=UTC) if session.expires_at.tzinfo is None else session.expires_at
    if expires <= now():
        raise denied()
    lifetime = get_settings().refresh_token_days * 86400
    rotated = create_token(owner_id, "refresh", lifetime, device_id, session_id)
    claimed = await db.execute(update(AuthSession).where(
        AuthSession.id == session_id, AuthSession.revoked_at.is_(None),
        AuthSession.refresh_token_hash == token_hash(body.refresh_token),
    ).values(refresh_token_hash=token_hash(rotated), expires_at=now() + timedelta(seconds=lifetime)))
    if int(getattr(claimed, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise denied()
    await db.commit()
    # A stable session keeps still-valid access tokens usable during rotation;
    # replayed refresh is rejected and logout/revocation invalidates all of them.
    return session_response(owner_id, device_id, session_id, rotated)


@router.post("/logout")
async def logout(body: NativeRefresh, db: AsyncSession = Depends(get_db)) -> dict[str, bool]:
    # Hash lookup permits sign-out even after JWT expiry and is idempotent. It
    # reveals no session existence. The secret must be the current refresh token.
    session = (await db.execute(select(AuthSession).where(
        AuthSession.refresh_token_hash == token_hash(body.refresh_token), AuthSession.revoked_at.is_(None),
    ))).scalar_one_or_none()
    if session and session.device_id:
        device = await db.get(Device, session.device_id)
        if device and device.owner_id == session.owner_id and device.platform in ("macos", "android"):
            await db.execute(update(AuthSession).where(
                AuthSession.id == session.id, AuthSession.refresh_token_hash == token_hash(body.refresh_token),
            ).values(revoked_at=now()))
            await db.commit()
    return {"logged_out": True}
