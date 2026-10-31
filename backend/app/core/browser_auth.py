"""Single-entry browser authentication with revocable device-bound refresh cookies."""
import secrets
from datetime import UTC, timedelta
from ipaddress import ip_address
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .api import guard_password_login, lock_owner_initialization
from .config import get_settings
from .db import get_db
from .models import AuthSession, Device, User, now
from .ratelimit import enforce
from .security import (
    create_token,
    decode_refresh_token,
    hash_password,
    token_hash,
    verify_password,
)

router = APIRouter(prefix="/auth/browser", tags=["browser session"])
COOKIE = "aelys_refresh"
COOKIE_PATH = "/api/v1/auth/browser"


class BrowserStatus(BaseModel):
    initialized: bool
    can_resume: bool
    # Whether the server still lets a first owner be created with a password (off by default).
    password_setup: bool = False


class BrowserSession(BaseModel):
    access_token: str
    device_id: str | None
    token_type: str = "bearer"


class BrowserLoginRequest(BaseModel):
    email: str
    password: str = Field(min_length=1, description="At least 8 characters, except the owner-selected 1/1 account on loopback requests.")


def validate_browser_password(body: BrowserLoginRequest, request: Request) -> None:
    if len(body.password) >= 8:
        return
    # The owner's requested 1/1 account is a loopback-only exception. It still
    # uses the stored password hash, owner lock, CSRF checks and device sessions.
    try:
        local_peer = request.client is not None and ip_address(request.client.host).is_loopback
    except ValueError:
        local_peer = False
    local_hosts = {"localhost", "127.0.0.1", "::1"}
    origin = request.headers.get("origin")
    local_origin = not origin or urlsplit(origin).hostname in local_hosts
    if body.email == "1" and body.password == "1" and local_peer and request.url.hostname in local_hosts and local_origin:
        return
    raise HTTPException(422, detail={"code": "VALIDATION_ERROR", "message": "Пароль должен содержать не менее 8 символов"})


def browser_request(request: Request) -> None:
    # A cross-origin form cannot set this header. Cross-origin fetch requires
    # CORS preflight, for which we grant no credentials or wildcard origin.
    if request.headers.get("x-aelys-browser") != "1":
        raise HTTPException(403, detail={"code": "CSRF_DENIED", "message": "Browser request header required"})
    origin = request.headers.get("origin")
    allowed = {str(request.base_url).rstrip("/"), *get_settings().browser_origins}
    if origin and origin not in allowed:
        raise HTTPException(403, detail={"code": "CSRF_DENIED", "message": "Browser origin not allowed"})
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, detail={"code": "CSRF_DENIED", "message": "Cross-site browser request denied"})


def set_refresh_cookie(request: Request, response: Response, token: str) -> None:
    # Plain HTTP is a development exception only for loopback, never remote hosts.
    secure = request.url.scheme == "https" or request.url.hostname not in {"127.0.0.1", "localhost", "::1"}
    response.set_cookie(COOKIE, token, max_age=get_settings().refresh_token_days * 86400,
                        httponly=True, secure=secure, samesite="strict", path=COOKIE_PATH)
    response.headers["Cache-Control"] = "no-store"


async def cookie_session(request: Request, db: AsyncSession) -> AuthSession | None:
    raw = request.cookies.get(COOKIE)
    if not raw:
        return None
    try:
        claims = decode_refresh_token(raw)
    except HTTPException:
        return None
    session = await db.get(AuthSession, claims.get("sid", ""))
    if not session or session.revoked_at or session.owner_id != claims["sub"] or session.refresh_token_hash != token_hash(raw):
        return None
    expires = session.expires_at.replace(tzinfo=UTC) if session.expires_at.tzinfo is None else session.expires_at
    if expires <= now() or not session.device_id or session.device_id != claims.get("device_id") or not await db.get(User, session.owner_id):
        return None
    device = await db.get(Device, session.device_id)
    if not device or device.revoked_at or device.owner_id != session.owner_id:
        return None
    return session


@router.get("/status", response_model=BrowserStatus)
async def status(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    initialized = (await db.execute(select(User.id).limit(1))).first() is not None
    return BrowserStatus(initialized=initialized, can_resume=await cookie_session(request, db) is not None, password_setup=get_settings().password_bootstrap_enabled)


async def start_browser_session(user: User, request: Request, response: Response, db: AsyncSession) -> BrowserSession:
    device = Device(id=str(uuid4()), owner_id=user.id, platform="web", display_name="Aelys Web", credential_hash=hash_password(secrets.token_urlsafe(32)))
    db.add(device)
    await db.flush()
    session_id = secrets.token_urlsafe(24)
    lifetime = get_settings().refresh_token_days * 86400
    refresh_token = create_token(user.id, "refresh", lifetime, device.id, session_id)
    db.add(AuthSession(id=session_id, owner_id=user.id, device_id=device.id, refresh_token_hash=token_hash(refresh_token), expires_at=now() + timedelta(seconds=lifetime)))
    await db.commit()
    set_refresh_cookie(request, response, refresh_token)
    return BrowserSession(access_token=create_token(user.id, "access", get_settings().access_token_minutes * 60, device.id, session_id), device_id=device.id)


@router.post("/login", response_model=BrowserSession, dependencies=[Depends(browser_request)])
async def login(body: BrowserLoginRequest, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    guard_password_login(request, body.email)
    validate_browser_password(body, request)
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if not user or not user.password_hash or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, detail={"code": "UNAUTHORIZED", "message": "Неверный email или пароль"})
    return await start_browser_session(user, request, response, db)


@router.post("/bootstrap", response_model=BrowserSession, dependencies=[Depends(browser_request)])
async def bootstrap(body: BrowserLoginRequest, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    enforce(request, "bootstrap", (10, 600))
    validate_browser_password(body, request)
    # Serialize first-owner creation; do not create two owners on concurrent setup.
    await lock_owner_initialization(db)
    if (await db.execute(select(User.id).limit(1))).first():
        raise HTTPException(409, detail={"code": "ALREADY_INITIALIZED", "message": "Аккаунт уже настроен. Войдите с существующим паролем."})
    user = User(email=body.email, password_hash=hash_password(body.password))
    db.add(user)
    await db.flush()
    return await start_browser_session(user, request, response, db)


@router.post("/refresh", response_model=BrowserSession, dependencies=[Depends(browser_request)])
async def refresh(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    enforce(request, "refresh", (300, 600))
    session = await cookie_session(request, db)
    if not session:
        raise HTTPException(401, detail={"code": "UNAUTHORIZED", "message": "Войдите в Aelys"})
    lifetime = get_settings().refresh_token_days * 86400
    # Keep the session identity stable so rotating in one tab does not revoke
    # still-valid access tokens in another tab. Logout still revokes them all.
    rotated = create_token(session.owner_id, "refresh", lifetime, session.device_id, session.id)
    claimed = await db.execute(update(AuthSession).where(
        AuthSession.id == session.id, AuthSession.revoked_at.is_(None),
        AuthSession.refresh_token_hash == token_hash(request.cookies[COOKIE]),
    ).values(refresh_token_hash=token_hash(rotated), expires_at=now() + timedelta(seconds=lifetime)))
    if int(getattr(claimed, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(401, detail={"code": "UNAUTHORIZED", "message": "Refresh token already used"})
    await db.commit()
    set_refresh_cookie(request, response, rotated)
    return BrowserSession(access_token=create_token(session.owner_id, "access", get_settings().access_token_minutes * 60, session.device_id, session.id), device_id=session.device_id)


@router.post("/logout", dependencies=[Depends(browser_request)])
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    session = await cookie_session(request, db)
    if session:
        session.revoked_at = now()
        await db.commit()
    response.delete_cookie(COOKIE, path=COOKIE_PATH, httponly=True, samesite="strict")
    response.headers["Cache-Control"] = "no-store"
    return {"logged_out": True}
