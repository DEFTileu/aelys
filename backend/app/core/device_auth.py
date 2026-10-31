"""Passwordless, key-bound device authentication and QR pairing.

Devices prove possession of an ECDSA P-256 key (Secure Enclave, Android Keystore or WebCrypto).
The server stores public keys only. See docs/QR_PAIRING_AUTH_PROPOSAL.md for the protocol and threat model.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
from datetime import UTC, datetime, timedelta

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import db as database
from .api import lock_owner_initialization
from .config import get_settings
from .db import get_db
from .models import (
    AuditLog,
    AuthSession,
    Device,
    DeviceChallenge,
    PairingSession,
    SetupToken,
    User,
    now,
)
from .ratelimit import enforce
from .schemas import TokenResponse
from .security import create_token, current_principal, token_hash

router = APIRouter()
log = logging.getLogger("aelys.setup")

LOGIN_CONTEXT = "aelys-device-login-v1"
REGISTER_CONTEXT = "aelys-device-register-v1"
FINISH_CONTEXT = "aelys-pairing-finish-v1"
SAS_CONTEXT = b"aelys-sas-v1|"
MAX_REQUEST_PAIRINGS = 20
MAX_INVITES = 5
MAX_CHALLENGES = 10
PLATFORM = "^(web|macos|android|helper)$"


# ---- crypto -----------------------------------------------------------------

def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def normalize_public_key(value: str) -> str:
    """Accept an uncompressed P-256 point or SPKI DER (base64url); store the point."""
    try:
        raw = _unb64(value.strip())
        if len(raw) == 65 and raw[0] == 4:
            key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
        else:
            loaded = serialization.load_der_public_key(raw)
            if not isinstance(loaded, ec.EllipticCurvePublicKey) or not isinstance(loaded.curve, ec.SECP256R1):
                raise ValueError("not a P-256 key")
            key = loaded
        point = key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    except Exception as error:  # cryptography raises several types for malformed keys
        raise HTTPException(422, detail={"code": "INVALID_PUBLIC_KEY", "message": "Expected a base64url P-256 public key"}) from error
    return base64.urlsafe_b64encode(point).rstrip(b"=").decode()


def verify_signature(public_key: str, message: bytes, signature: str) -> bool:
    """Verify an ES256 signature in raw (r||s, WebCrypto) or DER (Secure Enclave, Keystore) form."""
    try:
        key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), _unb64(public_key))
        raw = _unb64(signature)
        der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")) if len(raw) == 64 else raw
        key.verify(der, message, ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def sas_code(secret: str, pairing_id: str, public_key: str) -> str:
    """Six digits both devices derive locally; the owner types the new device's code into the trusted one."""
    digest = hmac.new(secret.encode(), SAS_CONTEXT + pairing_id.encode() + b"|" + _unb64(public_key), hashlib.sha256).digest()
    return f"{int.from_bytes(digest[:4], 'big') % 1_000_000:06d}"


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


# ---- schemas ----------------------------------------------------------------

class DeviceSession(TokenResponse):
    device_id: str


class SetupClaim(BaseModel):
    token: str = Field(min_length=20, max_length=128)
    public_key: str = Field(max_length=200)
    platform: str = Field(pattern=PLATFORM)
    display_name: str = Field(min_length=1, max_length=200)


class ChallengeRequest(BaseModel):
    device_id: str = Field(max_length=36)


class ChallengeResponse(BaseModel):
    challenge_id: str
    nonce: str
    expires_at: datetime


class DeviceLogin(BaseModel):
    challenge_id: str = Field(max_length=36)
    signature: str = Field(max_length=200)


class KeyRegister(BaseModel):
    public_key: str = Field(max_length=200)
    platform: str = Field(pattern=PLATFORM)
    display_name: str = Field(min_length=1, max_length=200)
    proof: str = Field(max_length=200)


class PairingCreate(BaseModel):
    secret_hash: str = Field(pattern="^[0-9a-f]{64}$")


class PairingRequestBody(PairingCreate):
    public_key: str = Field(max_length=200)
    platform: str = Field(pattern=PLATFORM)
    display_name: str = Field(min_length=1, max_length=200)


class PairingClaim(BaseModel):
    secret: str = Field(min_length=32, max_length=128)
    public_key: str = Field(max_length=200)
    platform: str = Field(pattern=PLATFORM)
    display_name: str = Field(min_length=1, max_length=200)


class PairingSecret(BaseModel):
    secret: str = Field(min_length=32, max_length=128)


class PairingApprove(PairingSecret):
    sas: str = Field(pattern=r"^\d{6}$")


class PairingFinish(BaseModel):
    signature: str = Field(max_length=200)


# ---- shared helpers ---------------------------------------------------------

def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def _audit(db: AsyncSession, owner_id: str, action: str, scope: str, outcome: str, correlation_id: str) -> None:
    db.add(AuditLog(owner_id=owner_id, action=action, actor="owner", scope=scope, decision="allow", outcome=outcome, correlation_id=correlation_id, redacted_metadata={}))


def _issue_session(db: AsyncSession, owner_id: str, device_id: str) -> DeviceSession:
    settings = get_settings()
    session_id = secrets.token_urlsafe(24)
    refresh = create_token(owner_id, "refresh", settings.refresh_token_days * 86400, device_id, session_id)
    db.add(AuthSession(id=session_id, owner_id=owner_id, device_id=device_id, refresh_token_hash=token_hash(refresh), expires_at=now() + timedelta(days=settings.refresh_token_days)))
    access = create_token(owner_id, "access", settings.access_token_minutes * 60, device_id, session_id)
    return DeviceSession(access_token=access, refresh_token=refresh, device_id=device_id)


def _new_device(owner_id: str, platform: str, display_name: str, public_key: str) -> Device:
    # credential_hash is unused for key-bound devices; it only satisfies the legacy NOT NULL column.
    return Device(owner_id=owner_id, platform=platform, display_name=display_name, public_key=public_key, credential_hash=token_hash(secrets.token_urlsafe(32)))


async def trusted_device(principal=Depends(current_principal)) -> tuple[User, Device]:
    user, device = principal
    if device is None or not device.public_key:
        raise _error(403, "TRUSTED_DEVICE_REQUIRED", "Use a device that holds a registered key")
    return user, device


# ---- first-run setup tokens -------------------------------------------------

async def issue_setup_token(db: AsyncSession, purpose: str) -> str:
    raw = secrets.token_urlsafe(24)
    db.add(SetupToken(token_hash=token_hash(raw), purpose=purpose, expires_at=now() + timedelta(minutes=get_settings().setup_token_minutes)))
    await db.commit()
    return raw


async def announce_first_run_token() -> None:
    """On an empty server print a one-time token to the console so the first device can claim ownership."""
    async with database.SessionLocal() as db:
        if (await db.execute(select(User.id).limit(1))).first():
            return
        token = await issue_setup_token(db, "first_owner")
    log.warning("First-run setup token (valid %s minutes, single use): %s", get_settings().setup_token_minutes, token)


@router.post("/auth/setup/claim", response_model=DeviceSession)
async def claim_setup(body: SetupClaim, request: Request, db: AsyncSession = Depends(get_db)):
    enforce(request, "setup-claim", (10, 600))
    public_key = normalize_public_key(body.public_key)
    await lock_owner_initialization(db, password=False)
    row = (await db.execute(select(SetupToken).where(SetupToken.token_hash == token_hash(body.token)))).scalar_one_or_none()
    if not row or row.consumed_at or _aware(row.expires_at) <= now():
        raise _error(401, "INVALID_SETUP_TOKEN", "Setup token is invalid, used or expired")
    existing = (await db.execute(select(User))).scalars().first()
    if row.purpose == "first_owner":
        if existing:
            raise _error(409, "ALREADY_INITIALIZED", "Owner already exists")
        user = User(email=None, password_hash=None)
        db.add(user)
        await db.flush()
    else:
        if not existing:
            raise _error(409, "NOT_INITIALIZED", "No owner to recover")
        user = existing
    claimed = await db.execute(update(SetupToken).where(SetupToken.id == row.id, SetupToken.consumed_at.is_(None)).values(consumed_at=now()))
    if int(getattr(claimed, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise _error(401, "INVALID_SETUP_TOKEN", "Setup token is invalid, used or expired")
    device = _new_device(user.id, body.platform, body.display_name, public_key)
    db.add(device)
    await db.flush()
    _audit(db, user.id, f"device.setup.{row.purpose}", f"device:{device.id}", "enrolled", device.id)
    session = _issue_session(db, user.id, device.id)
    await db.commit()
    return session


# ---- key-bound device login --------------------------------------------------

@router.post("/auth/device/challenge", response_model=ChallengeResponse)
async def device_challenge(body: ChallengeRequest, request: Request, db: AsyncSession = Depends(get_db)):
    enforce(request, "device-challenge", (120, 60), body.device_id, (30, 60))
    device = await db.get(Device, body.device_id)
    if not device or device.revoked_at or not device.public_key:
        raise _error(401, "UNAUTHORIZED", "Unknown or revoked device")
    await db.execute(delete(DeviceChallenge).where(DeviceChallenge.device_id == device.id, DeviceChallenge.expires_at < now()))
    outstanding = (await db.execute(select(func.count()).select_from(DeviceChallenge).where(DeviceChallenge.device_id == device.id, DeviceChallenge.used_at.is_(None)))).scalar_one()
    if outstanding >= MAX_CHALLENGES:
        raise _error(429, "TOO_MANY_CHALLENGES", "Finish a pending sign-in before starting another")
    challenge = DeviceChallenge(device_id=device.id, nonce=secrets.token_urlsafe(32), expires_at=now() + timedelta(seconds=get_settings().device_challenge_seconds))
    db.add(challenge)
    await db.commit()
    return ChallengeResponse(challenge_id=challenge.id, nonce=challenge.nonce, expires_at=challenge.expires_at)


@router.post("/auth/device/login", response_model=DeviceSession)
async def device_login(body: DeviceLogin, request: Request, db: AsyncSession = Depends(get_db)):
    enforce(request, "device-login", (120, 60), body.challenge_id, (10, 60))
    challenge = await db.get(DeviceChallenge, body.challenge_id)
    if not challenge or challenge.used_at or _aware(challenge.expires_at) <= now():
        raise _error(401, "UNAUTHORIZED", "Challenge is invalid or expired")
    # Burn the challenge first so a failed or replayed signature can never be retried.
    used = await db.execute(update(DeviceChallenge).where(DeviceChallenge.id == challenge.id, DeviceChallenge.used_at.is_(None)).values(used_at=now()))
    await db.commit()
    if int(getattr(used, "rowcount", 0) or 0) != 1:
        raise _error(401, "UNAUTHORIZED", "Challenge is invalid or expired")
    device = await db.get(Device, challenge.device_id)
    message = f"{LOGIN_CONTEXT}\n{challenge.device_id}\n{challenge.nonce}".encode()
    if not device or device.revoked_at or not device.public_key or not verify_signature(device.public_key, message, body.signature):
        raise _error(401, "UNAUTHORIZED", "Signature rejected")
    device.last_seen_at = now()
    session = _issue_session(db, device.owner_id, device.id)
    await db.commit()
    return session


@router.post("/devices/register-key", response_model=DeviceSession)
async def register_key(body: KeyRegister, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    """Migrate a password session to a key-bound device; the key must sign over the owner and itself."""
    user, _ = principal
    public_key = normalize_public_key(body.public_key)
    if not verify_signature(public_key, f"{REGISTER_CONTEXT}\n{user.id}\n{public_key}".encode(), body.proof):
        raise _error(401, "INVALID_PROOF", "Key possession proof rejected")
    device = _new_device(user.id, body.platform, body.display_name, public_key)
    db.add(device)
    await db.flush()
    _audit(db, user.id, "device.register_key", f"device:{device.id}", "enrolled", device.id)
    session = _issue_session(db, user.id, device.id)
    await db.commit()
    return session


# ---- QR pairing ---------------------------------------------------------------

async def _load_pairing(db: AsyncSession, pairing_id: str) -> PairingSession:
    row = await db.get(PairingSession, pairing_id)
    if not row:
        raise _error(404, "NOT_FOUND", "Pairing not found")
    if _aware(row.expires_at) <= now():
        raise _error(410, "PAIRING_EXPIRED", "Pairing expired; start again")
    if row.state == "locked":
        raise _error(423, "PAIRING_LOCKED", "Too many wrong attempts; start again")
    return row


async def _fail(db: AsyncSession, row: PairingSession, code: str, message: str) -> HTTPException:
    row.failed_attempts += 1
    if row.failed_attempts >= get_settings().pairing_max_attempts:
        row.state = "locked"
    await db.commit()
    return _error(403, code, message)


async def _check_secret(db: AsyncSession, row: PairingSession, secret: str) -> None:
    if not hmac.compare_digest(token_hash(secret), row.secret_hash):
        raise await _fail(db, row, "INVALID_PAIRING_SECRET", "QR code does not match this pairing")


async def _purge_expired(db: AsyncSession) -> None:
    stale = now() - timedelta(minutes=10)
    for row in (await db.execute(select(PairingSession).where(PairingSession.expires_at < stale))).scalars():
        await db.delete(row)


def _pairing_expiry() -> datetime:
    return now() + timedelta(seconds=get_settings().pairing_ttl_seconds)


@router.post("/pairing/invite")
async def pairing_invite(body: PairingCreate, principal=Depends(trusted_device), db: AsyncSession = Depends(get_db)):
    """A trusted device offers a QR; the raw secret stays in the QR and only its hash is registered."""
    user, device = principal
    await _purge_expired(db)
    active = (await db.execute(select(func.count()).select_from(PairingSession).where(PairingSession.owner_id == user.id, PairingSession.kind == "invite", PairingSession.state.in_(("pending", "claimed")), PairingSession.expires_at > now()))).scalar_one()
    if active >= MAX_INVITES:
        raise _error(429, "TOO_MANY_PAIRINGS", "Finish or wait out the pending pairings first")
    row = PairingSession(kind="invite", state="pending", owner_id=user.id, created_by_device_id=device.id, secret_hash=body.secret_hash, expires_at=_pairing_expiry())
    db.add(row)
    await db.commit()
    return {"pairing_id": row.id, "expires_at": row.expires_at}


@router.post("/pairing/request")
async def pairing_request(body: PairingRequestBody, request: Request, db: AsyncSession = Depends(get_db)):
    """A new device offers a QR (web or desktop without a camera); a trusted phone scans and approves it."""
    enforce(request, "pairing-request", (20, 600))
    public_key = normalize_public_key(body.public_key)
    await _purge_expired(db)
    active = (await db.execute(select(func.count()).select_from(PairingSession).where(PairingSession.kind == "request", PairingSession.state.in_(("pending", "claimed", "approved")), PairingSession.expires_at > now()))).scalar_one()
    if active >= MAX_REQUEST_PAIRINGS:
        raise _error(429, "TOO_MANY_PAIRINGS", "Too many pending pairings; try again shortly")
    row = PairingSession(kind="request", state="claimed", secret_hash=body.secret_hash, platform=body.platform, display_name=body.display_name, public_key=public_key, expires_at=_pairing_expiry())
    db.add(row)
    await db.commit()
    return {"pairing_id": row.id, "expires_at": row.expires_at}


@router.post("/pairing/{pairing_id}/claim")
async def pairing_claim(pairing_id: str, body: PairingClaim, request: Request, db: AsyncSession = Depends(get_db)):
    """The new device scanned a trusted device's QR and presents its key."""
    enforce(request, "pairing-claim", (30, 600), pairing_id, (20, 600))
    row = await _load_pairing(db, pairing_id)
    if row.kind != "invite":
        raise _error(409, "WRONG_PAIRING_KIND", "This pairing was started by the new device")
    await _check_secret(db, row, body.secret)
    public_key = normalize_public_key(body.public_key)
    claimed = await db.execute(update(PairingSession).where(PairingSession.id == row.id, PairingSession.state == "pending").values(state="claimed", public_key=public_key, platform=body.platform, display_name=body.display_name))
    await db.commit()
    if int(getattr(claimed, "rowcount", 0) or 0) != 1:
        raise _error(409, "PAIRING_ALREADY_CLAIMED", "This QR was already used")
    return {"status": "awaiting_approval", "expires_at": row.expires_at}


def _owns_or_scanned(row: PairingSession, user: User) -> bool:
    return row.kind == "request" or row.owner_id == user.id


@router.post("/pairing/{pairing_id}/inspect")
async def pairing_inspect(pairing_id: str, body: PairingSecret, principal=Depends(trusted_device), db: AsyncSession = Depends(get_db)):
    """What the trusted device shows before the owner confirms: who is asking and a key fingerprint."""
    user, _ = principal
    row = await _load_pairing(db, pairing_id)
    if not _owns_or_scanned(row, user):
        raise _error(404, "NOT_FOUND", "Pairing not found")
    await _check_secret(db, row, body.secret)
    fingerprint = hashlib.sha256(_unb64(row.public_key)).hexdigest()[:16] if row.public_key else None
    return {"state": row.state, "kind": row.kind, "platform": row.platform, "display_name": row.display_name, "key_fingerprint": fingerprint, "expires_at": row.expires_at}


@router.post("/pairing/{pairing_id}/approve")
async def pairing_approve(pairing_id: str, body: PairingApprove, principal=Depends(trusted_device), db: AsyncSession = Depends(get_db)):
    """The owner typed the six digits shown on the new device; only then is the device registered."""
    user, approver = principal
    row = await _load_pairing(db, pairing_id)
    if not _owns_or_scanned(row, user):
        raise _error(404, "NOT_FOUND", "Pairing not found")
    await _check_secret(db, row, body.secret)
    if row.state != "claimed" or not row.public_key or not row.platform or not row.display_name:
        raise _error(409, "PAIRING_NOT_READY", "The new device has not presented its key yet")
    if not hmac.compare_digest(sas_code(body.secret, row.id, row.public_key), body.sas):
        raise await _fail(db, row, "SAS_MISMATCH", "The confirmation code does not match the new device")
    device = _new_device(user.id, row.platform, row.display_name, row.public_key)
    db.add(device)
    await db.flush()
    approved = await db.execute(update(PairingSession).where(PairingSession.id == row.id, PairingSession.state == "claimed").values(state="approved", owner_id=user.id, device_id=device.id, approved_at=now(), expires_at=_pairing_expiry()))
    if int(getattr(approved, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise _error(409, "PAIRING_NOT_READY", "Pairing is no longer awaiting approval")
    _audit(db, user.id, "device.pair.approve", f"device:{device.id}", "approved", approver.id)
    await db.commit()
    return {"device_id": device.id}


@router.post("/pairing/{pairing_id}/reject")
async def pairing_reject(pairing_id: str, body: PairingSecret, principal=Depends(trusted_device), db: AsyncSession = Depends(get_db)):
    user, rejecter = principal
    row = await _load_pairing(db, pairing_id)
    if not _owns_or_scanned(row, user):
        raise _error(404, "NOT_FOUND", "Pairing not found")
    await _check_secret(db, row, body.secret)
    rejected = await db.execute(update(PairingSession).where(PairingSession.id == row.id, PairingSession.state.in_(("pending", "claimed"))).values(state="rejected"))
    _audit(db, user.id, "device.pair.reject", f"pairing:{row.id}", "rejected", rejecter.id)
    await db.commit()
    return {"rejected": int(getattr(rejected, "rowcount", 0) or 0) == 1}


@router.post("/pairing/{pairing_id}/finish", response_model=DeviceSession)
async def pairing_finish(pairing_id: str, body: PairingFinish, request: Request, db: AsyncSession = Depends(get_db)):
    """The new device polls this; once approved it signs the pairing id to prove it holds the key and gets its first session."""
    enforce(request, "pairing-finish", (300, 600), pairing_id, (120, 600))
    row = await _load_pairing(db, pairing_id)
    if row.state in ("pending", "claimed"):
        raise _error(409, "PAIRING_PENDING", "Waiting for the owner to approve")
    if row.state == "rejected":
        raise _error(403, "PAIRING_REJECTED", "The owner rejected this device")
    if row.state != "approved" or not row.public_key or not row.device_id or not row.owner_id:
        raise _error(410, "PAIRING_EXPIRED", "Pairing already used; start again")
    if not verify_signature(row.public_key, f"{FINISH_CONTEXT}\n{row.id}".encode(), body.signature):
        raise await _fail(db, row, "INVALID_PROOF", "Key possession proof rejected")
    consumed = await db.execute(update(PairingSession).where(PairingSession.id == row.id, PairingSession.state == "approved").values(state="consumed"))
    if int(getattr(consumed, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise _error(410, "PAIRING_EXPIRED", "Pairing already used; start again")
    session = _issue_session(db, row.owner_id, row.device_id)
    await db.commit()
    return session
