"""Owner-only, read-only Google Calendar OAuth; no remote event writes."""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal
from urllib.parse import unquote, urlencode, urlparse, urlunsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from app.ai.crypto import decrypt_secret, encrypt_secret
from app.ai.errors import PolicyDenied
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.core.config import Settings, get_settings
from app.core.db import get_db
from app.core.models import Device, User, now
from app.core.security import current_principal, decode_token
from app.sync.change_log import lock_owner
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, field_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .google_calendar_models import (
    GoogleCalendarConnection,
    GoogleCalendarCredential,
    GoogleCalendarOAuthState,
)
from .google_oauth import active_oauth_session, consume_oauth_state, create_pkce
from .recurrence import utc

router = APIRouter(prefix='/calendar/google', tags=['google-calendar'])
SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
SCOPES = frozenset({SCOPE})
COOKIE = 'aelys_google_calendar_state'
COOKIE_PATH = '/api/v1/calendar/google'
API = 'https://www.googleapis.com/calendar/v3'
TOKEN_URL = 'https://oauth2.googleapis.com/token'


class _GoogleLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage() + (record.exc_text or '') + (record.stack_info or '')
        if record.exc_info:
            message += logging.Formatter().formatException(record.exc_info)
        # HTTPX INFO URLs can contain opaque sync/page tokens. Provider diagnostic
        # errors may contain headers; suppress these records without echoing them.
        return not any(value in message.lower() for value in ('www.googleapis.com/calendar/', 'oauth2.googleapis.com'))


_log_filter = _GoogleLogFilter()
for _name in ('httpx', 'httpcore', 'httpcore.connection', 'httpcore.http11', 'httpcore.http2', 'httpcore.proxy'):
    logging.getLogger(_name).addFilter(_log_filter)


def _error(code: str, status: int = 409) -> HTTPException:
    messages = {
        'CALENDAR_NOT_CONFIGURED': 'Configure the Google OAuth client and Calendar callback URL on the backend.',
        'CALENDAR_RECONNECT_REQUIRED': 'Reconnect Google Calendar to renew read access.',
        'CALENDAR_SCOPE_REQUIRED': 'Reconnect Google Calendar and grant read-only Calendar access.',
        'CALENDAR_SYNC_EXPIRED': 'Google Calendar requires a fresh import.',
        'CALENDAR_UNAVAILABLE': 'Google Calendar did not confirm the request.',
    }
    return HTTPException(status, detail={'code': code, 'message': messages[code]})


def configured() -> Settings:
    settings = get_settings()
    parsed = urlparse(settings.calendar_redirect_uri or '')
    valid_uri = bool(parsed.hostname) and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and parsed.path == COOKIE_PATH + '/callback' and (
        parsed.scheme == 'https' or (parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1'}))
    if not settings.gmail_client_id or not settings.gmail_client_secret or not valid_uri:
        raise _error('CALENDAR_NOT_CONFIGURED', 503)
    return settings


@dataclass
class _CalendarPolicy:
    name: str
    required_scope: str
    external_effect: bool = False


def authorize_calendar(owner_id: str, scope: str = 'calendar.import', *, external: bool = False) -> None:
    if scope not in {'calendar.connect', 'calendar.import'}:
        raise ValueError('Unknown Calendar policy scope')
    try:
        ServerPolicyEngine().authorize(_CalendarPolicy(scope, scope, external), ToolCall(scope, {}),
            PermissionContext(actor=f'owner:{owner_id}', scopes=frozenset({scope}),
                              allow_external_effects=external, policy_id='owner-google-calendar'))
    except PolicyDenied:
        raise HTTPException(403, detail={'code': 'POLICY_DENIED', 'message': 'Google Calendar access denied by policy.'}) from None


async def google_calendar_request(method: str, url: str, **kwargs: Any) -> dict[str, Any]:
    """Caller authorizes owner external effects; transport allows only reads/token exchange."""
    parsed = urlparse(url)
    allowed = ((method == 'POST' and url == TOKEN_URL) or
        (method == 'GET' and parsed.scheme == 'https' and parsed.netloc == 'www.googleapis.com'
         and parsed.path.startswith('/calendar/v3/') and not parsed.fragment))
    if any(part in {'.', '..'} for part in unquote(parsed.path).split('/')):
        allowed = False
    if not allowed:
        raise _error('CALENDAR_UNAVAILABLE', 502)
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            response = await client.request(method, url, **kwargs)
        if response.status_code in {401, 403}:
            raise _error('CALENDAR_RECONNECT_REQUIRED')
        if url == TOKEN_URL and response.status_code == 400:
            failure = response.json()
            if isinstance(failure, dict) and failure.get('error') == 'invalid_grant':
                raise _error('CALENDAR_RECONNECT_REQUIRED')
        if response.status_code == 410:
            raise _error('CALENDAR_SYNC_EXPIRED')
        if not 200 <= response.status_code < 300:
            raise _error('CALENDAR_UNAVAILABLE', 502)
        payload = response.json() if response.content else {}
        if not isinstance(payload, dict):
            raise _error('CALENDAR_UNAVAILABLE', 502)
        return payload
    except (httpx.HTTPError, ValueError):
        raise _error('CALENDAR_UNAVAILABLE', 502) from None


def _tokens(payload: dict[str, Any], *, fallback: dict[str, Any] | None = None,
            code: str = 'CALENDAR_RECONNECT_REQUIRED') -> dict[str, Any]:
    previous = fallback or {}
    scope = payload.get('scope', previous.get('scope', ''))
    refresh = payload.get('refresh_token', previous.get('refresh_token'))
    access = payload.get('access_token')
    if (not isinstance(scope, str) or set(scope.split()) != SCOPES or not isinstance(access, str) or not access
            or not isinstance(refresh, str) or not refresh):
        raise _error(code)
    try:
        ttl = float(payload.get('expires_in', 3600))
        if not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
            raise ValueError('Invalid expiry')
    except (TypeError, ValueError, OverflowError):
        raise _error(code) from None
    return {'access_token': access, 'refresh_token': refresh, 'scope': scope,
            'expires_at': time.time() + ttl}


async def access_token(db: AsyncSession, connection: GoogleCalendarConnection) -> str:
    authorize_calendar(connection.owner_id, 'calendar.import', external=True)
    current = (await db.execute(select(GoogleCalendarConnection.id).where(
        GoogleCalendarConnection.id == connection.id, GoogleCalendarConnection.owner_id == connection.owner_id,
        GoogleCalendarConnection.version == connection.version, GoogleCalendarConnection.deleted_at.is_(None),
        GoogleCalendarConnection.connection_status.in_(['connected', 'error'])))).scalar_one_or_none()
    credential = await db.get(GoogleCalendarCredential, connection.id) if current else None
    if credential is None:
        raise _error('CALENDAR_RECONNECT_REQUIRED')
    encrypted_before = credential.encrypted_tokens
    try:
        tokens = json.loads(decrypt_secret(encrypted_before))
        if (not isinstance(tokens, dict) or set(str(tokens.get('scope', '')).split()) != SCOPES
                or not isinstance(tokens.get('access_token'), str) or not tokens['access_token']
                or not isinstance(tokens.get('refresh_token'), str) or not tokens['refresh_token']):
            raise ValueError('Invalid credentials')
        expires = float(tokens.get('expires_at', 0))
        if not math.isfinite(expires):
            raise ValueError('Invalid expiry')
    except Exception:  # noqa: BLE001 - ciphertext/key/JSON errors never leave the credential boundary
        raise _error('CALENDAR_RECONNECT_REQUIRED') from None
    if expires >= time.time() + 60:
        return tokens['access_token']
    settings = configured()
    refreshed = await google_calendar_request('POST', TOKEN_URL, data={
        'client_id': settings.gmail_client_id, 'client_secret': settings.gmail_client_secret,
        'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token'],
    })
    updated = _tokens(refreshed, fallback=tokens)
    authorize_calendar(connection.owner_id, 'calendar.import')
    active = select(GoogleCalendarConnection.id).where(GoogleCalendarConnection.id == connection.id,
        GoogleCalendarConnection.owner_id == connection.owner_id, GoogleCalendarConnection.version == connection.version,
        GoogleCalendarConnection.deleted_at.is_(None), GoogleCalendarConnection.connection_status.in_(['connected', 'error']))
    saved = await db.execute(update(GoogleCalendarCredential).where(
        GoogleCalendarCredential.connection_id == connection.id, GoogleCalendarCredential.encrypted_tokens == encrypted_before,
        active.exists()).values(encrypted_tokens=encrypt_secret(json.dumps(updated))).execution_options(synchronize_session=False))
    if int(getattr(saved, 'rowcount', 0) or 0) != 1:
        raise _error('CALENDAR_RECONNECT_REQUIRED')
    await db.commit()
    return updated['access_token']


class CalendarConnectionOut(BaseModel):
    id: str
    version: int
    calendar_id: str
    status: Literal['connected', 'error', 'disconnected']
    last_synced_at: datetime | None
    last_error_code: str | None

    @field_validator('last_synced_at')
    @classmethod
    def utc_instant(cls, value: datetime | None) -> datetime | None:
        return utc(value) if value is not None else None


class CalendarStatusOut(BaseModel):
    configured: bool
    connection: CalendarConnectionOut | None


class CalendarConnectOut(BaseModel):
    authorization_url: str


@router.get('/status', response_model=CalendarStatusOut)
async def status(principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    owner, _ = principal
    try:
        configured()
        available = True
    except HTTPException:
        available = False
    connection = (await db.execute(select(GoogleCalendarConnection).where(
        GoogleCalendarConnection.owner_id == owner.id, GoogleCalendarConnection.deleted_at.is_(None),
        GoogleCalendarConnection.connection_status != 'disconnected'))).scalar_one_or_none()
    body = CalendarStatusOut(configured=available, connection=CalendarConnectionOut.model_validate({
        'id': connection.id, 'version': connection.version, 'calendar_id': connection.calendar_id,
        'status': connection.connection_status, 'last_synced_at': connection.last_synced_at,
        'last_error_code': connection.last_error_code}) if connection else None)
    return JSONResponse(body.model_dump(mode='json'), headers={'Cache-Control': 'no-store'})


def consent_url(settings: Settings, state: str, challenge: str) -> str:
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode({
        'client_id': settings.gmail_client_id, 'redirect_uri': settings.calendar_redirect_uri,
        'response_type': 'code', 'scope': SCOPE, 'state': state, 'code_challenge': challenge,
        'code_challenge_method': 'S256', 'access_type': 'offline', 'prompt': 'consent', 'include_granted_scopes': 'false',
    })


def state_cookie(response: Response, settings: Settings, state: str) -> None:
    response.set_cookie(COOKIE, state, max_age=600, httponly=True,
        secure=bool(settings.calendar_redirect_uri and settings.calendar_redirect_uri.startswith('https://')),
        samesite='lax', path=COOKIE_PATH)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'


async def start_connection(authorization: str, principal: tuple[User, Device | None], db: AsyncSession, *, browser: bool) -> JSONResponse:
    settings = configured()
    owner, _ = principal
    authorize_calendar(owner.id, 'calendar.connect', external=True)
    claims = decode_token(authorization.split(' ', 1)[1])
    state, verifier, challenge = create_pkce()
    db.add(GoogleCalendarOAuthState(state_hash=hashlib.sha256(state.encode()).hexdigest(), owner_id=owner.id,
        session_id=claims['sid'], encrypted_verifier=encrypt_secret(verifier), expires_at=now() + timedelta(minutes=10),
        browser_state='pending' if browser else None))
    await db.commit()
    if browser:
        callback = urlparse(settings.calendar_redirect_uri or '')
        url = urlunsplit((callback.scheme, callback.netloc, COOKIE_PATH + '/authorize', urlencode({'ticket': state}), ''))
        return JSONResponse({'authorization_url': url}, headers={'Cache-Control': 'no-store'})
    response = JSONResponse({'authorization_url': consent_url(settings, state, challenge)})
    state_cookie(response, settings, state)
    return response


@router.post('/connect', response_model=CalendarConnectOut)
async def connect(authorization: str = Header(), principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    return await start_connection(authorization, principal, db, browser=False)


@router.post('/browser-connect', response_model=CalendarConnectOut)
async def browser_connect(authorization: str = Header(), principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    return await start_connection(authorization, principal, db, browser=True)


@router.get('/authorize', include_in_schema=False)
async def authorize(ticket: str = Query(min_length=32, max_length=200), db: AsyncSession = Depends(get_db)):
    settings = configured()
    hashed = hashlib.sha256(ticket.encode()).hexdigest()
    record = await db.get(GoogleCalendarOAuthState, hashed)
    at = now()
    if not record or record.browser_state != 'pending' or utc(record.expires_at) <= utc(at):
        raise HTTPException(400, detail={'code': 'INVALID_OAUTH_STATE', 'message': 'Restart the Calendar connection in Aelys.'})
    authorize_calendar(record.owner_id, 'calendar.connect', external=True)
    verifier = decrypt_secret(record.encrypted_verifier)
    claimed = await db.execute(update(GoogleCalendarOAuthState).where(GoogleCalendarOAuthState.state_hash == hashed,
        GoogleCalendarOAuthState.browser_state == 'pending', GoogleCalendarOAuthState.expires_at > at,
        active_oauth_session(record, at).exists()).values(browser_state='started'))
    await db.commit()
    if int(getattr(claimed, 'rowcount', 0) or 0) != 1:
        raise HTTPException(401, detail={'code': 'UNAUTHORIZED', 'message': 'Sign in to Aelys and reconnect Calendar.'})
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    response = RedirectResponse(consent_url(settings, ticket, challenge), status_code=303)
    state_cookie(response, settings, ticket)
    return response


def browser_complete(connected: bool) -> HTMLResponse:
    title = 'Google Calendar connected' if connected else 'Google Calendar connection cancelled'
    message = 'Return to Aelys. Your read-only Calendar connection is ready.' if connected else 'Return to Aelys to try connecting Calendar again.'
    response = HTMLResponse(f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><h1>{title}</h1><p>{message}</p></html>',
        headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
                 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"})
    response.delete_cookie(COOKIE, path=COOKIE_PATH)
    return response


def _redirect(settings: Settings) -> RedirectResponse:
    parsed = urlparse(settings.calendar_redirect_uri or '')
    response = RedirectResponse(urlunsplit((parsed.scheme, parsed.netloc, '/settings', 'section=calendar', '')), status_code=303)
    response.delete_cookie(COOKIE, path=COOKIE_PATH)
    response.headers['Cache-Control'] = 'no-store'
    return response


@router.get('/callback', include_in_schema=False)
async def callback(request: Request, state: str = Query(max_length=200), code: str | None = Query(default=None, max_length=4096),
                   error: str | None = Query(default=None, max_length=100), db: AsyncSession = Depends(get_db)):
    settings = configured()
    baseline: tuple[str, int] | None = None
    async def snapshot_connection(owner_id: str) -> None:
        nonlocal baseline
        # Match disconnect's owner -> state lock order. Consuming commits the
        # snapshot transaction before any network I/O; there is no commit/read gap.
        await lock_owner(db, owner_id)
        row = (await db.execute(select(GoogleCalendarConnection.id, GoogleCalendarConnection.version)
            .where(GoogleCalendarConnection.owner_id == owner_id))).one_or_none()
        baseline = (row.id, row.version) if row else None
    record, verifier = await consume_oauth_state(db, GoogleCalendarOAuthState, state, request.cookies.get(COOKIE, ''),
        authorize=lambda owner_id: authorize_calendar(owner_id, 'calendar.connect'), before_consume=snapshot_connection)
    assert isinstance(record, GoogleCalendarOAuthState)
    if record.browser_state not in {None, 'started'}:
        raise HTTPException(400, detail={'code': 'INVALID_OAUTH_STATE', 'message': 'Restart the Calendar connection in Aelys.'})
    if error or not code:
        return browser_complete(False) if record.browser_state is not None else _redirect(settings)
    owner_id = record.owner_id
    authorize_calendar(owner_id, 'calendar.connect', external=True)
    raw_tokens = await google_calendar_request('POST', TOKEN_URL, data={
        'client_id': settings.gmail_client_id, 'client_secret': settings.gmail_client_secret,
        'redirect_uri': settings.calendar_redirect_uri, 'code': code, 'code_verifier': verifier,
        'grant_type': 'authorization_code',
    })
    tokens = _tokens(raw_tokens, code='CALENDAR_SCOPE_REQUIRED')
    authorize_calendar(owner_id, 'calendar.connect', external=True)
    profile = await google_calendar_request('GET', API + '/calendars/primary', headers={'Authorization': f'Bearer {tokens["access_token"]}'})
    calendar_id, timezone = profile.get('id'), profile.get('timeZone', 'UTC')
    try:
        if not isinstance(calendar_id, str) or not 1 <= len(calendar_id) <= 320 or not isinstance(timezone, str) or len(timezone) > 64:
            raise ValueError('Invalid calendar')
        ZoneInfo(timezone)
    except (ValueError, ZoneInfoNotFoundError):
        raise _error('CALENDAR_UNAVAILABLE', 502) from None
    authorize_calendar(owner_id, 'calendar.connect')
    await lock_owner(db, owner_id)
    if not await db.scalar(select(active_oauth_session(record, now()).exists())):
        raise HTTPException(401, detail={'code': 'UNAUTHORIZED', 'message': 'Sign in to Aelys and reconnect Calendar.'})
    connection = (await db.execute(select(GoogleCalendarConnection).where(GoogleCalendarConnection.owner_id == owner_id)
        .execution_options(populate_existing=True))).scalar_one_or_none()
    current = (connection.id, connection.version) if connection else None
    if current != baseline:
        raise HTTPException(409, detail={'code': 'CALENDAR_SYNC_BUSY',
            'message': 'Google Calendar changed during connection. Start the connection again.'})
    if connection is None:
        connection = GoogleCalendarConnection(owner_id=owner_id)
        db.add(connection)
        await db.flush()
    else:
        connection.version += 1
    connection.calendar_id, connection.calendar_timezone = calendar_id, timezone
    connection.connection_status, connection.deleted_at = 'connected', None
    connection.encrypted_sync_token = connection.last_error_code = None
    connection.last_synced_at = connection.last_attempt_at = None
    connection.lease_owner = connection.lease_expires_at = None
    credential = await db.get(GoogleCalendarCredential, connection.id)
    encrypted = encrypt_secret(json.dumps(tokens))
    if credential is None:
        db.add(GoogleCalendarCredential(connection_id=connection.id, encrypted_tokens=encrypted))
    else:
        credential.encrypted_tokens = encrypted
    await db.commit()
    return browser_complete(True) if record.browser_state is not None else _redirect(settings)
