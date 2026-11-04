"""Shared PKCE and one-use, owner/session-bound Google OAuth state checks."""
import base64
import hashlib
import secrets
from collections.abc import Awaitable, Callable
from datetime import datetime

from app.ai.crypto import decrypt_secret
from app.core.models import AuthSession, Device, GmailOAuthState, now
from fastapi import HTTPException
from sqlalchemy import Select, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .google_calendar_models import GoogleCalendarOAuthState
from .recurrence import utc

type OAuthState = GmailOAuthState | GoogleCalendarOAuthState


def create_pkce() -> tuple[str, str, str]:
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    return state, verifier, challenge


def _invalid() -> HTTPException:
    return HTTPException(400, detail={'code': 'INVALID_OAUTH_STATE', 'message': 'Restart the Google connection in the same browser.'})


def active_oauth_session(record: OAuthState, at: datetime) -> Select[tuple[str]]:
    valid_device = select(Device.id).where(Device.owner_id == record.owner_id,
        Device.revoked_at.is_(None), Device.deleted_at.is_(None))
    valid_session = select(AuthSession.id).where(AuthSession.id == record.session_id,
        AuthSession.owner_id == record.owner_id, AuthSession.revoked_at.is_(None), AuthSession.expires_at > at,
        or_(AuthSession.device_id.is_(None), AuthSession.device_id.in_(valid_device)))
    return valid_session


async def consume_oauth_state(db: AsyncSession, model: type[GmailOAuthState] | type[GoogleCalendarOAuthState],
                              state: str, cookie: str, *, authorize: Callable[[str], None] | None = None,
                              before_consume: Callable[[str], Awaitable[None]] | None = None) -> tuple[OAuthState, str]:
    if not state or not secrets.compare_digest(cookie.encode(), state.encode()):
        raise _invalid()
    state_hash = hashlib.sha256(state.encode()).hexdigest()
    record = await db.get(model, state_hash)
    at = utc(now())
    if record is None or utc(record.expires_at) <= at:
        raise _invalid()
    session = await db.get(AuthSession, record.session_id)
    device = await db.get(Device, session.device_id) if session and session.device_id else None
    if (not session or session.owner_id != record.owner_id or session.revoked_at or utc(session.expires_at) <= at
            or (session.device_id and (not device or device.owner_id != record.owner_id or device.revoked_at or device.deleted_at))):
        raise HTTPException(401, detail={'code': 'UNAUTHORIZED', 'message': 'Open an owner session and reconnect Google.'})
    verifier = decrypt_secret(record.encrypted_verifier)
    if authorize:
        authorize(record.owner_id)
    if before_consume:
        await before_consume(record.owner_id)
    # Repeat authority checks inside the delete as well, so a concurrent revoke
    # cannot pass a stale ORM identity-map check. Only one callback wins state.
    valid_session = active_oauth_session(record, at)
    consumed = await db.execute(delete(model).where(model.state_hash == state_hash,
        model.owner_id == record.owner_id, model.session_id == record.session_id, model.expires_at > at,
        valid_session.exists()).execution_options(synchronize_session=False))
    db.expunge(record)
    await db.commit()
    if int(getattr(consumed, 'rowcount', 0) or 0) != 1:
        raise _invalid()
    return record, verifier
