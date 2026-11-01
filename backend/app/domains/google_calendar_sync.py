"""Read-only Google fetch; atomic, versioned local import behind a durable lease."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from urllib.parse import quote
from uuid import NAMESPACE_URL, uuid4, uuid5
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.ai.crypto import decrypt_secret, encrypt_secret
from app.core import db as database
from app.core.models import CalendarEvent, SyncRecord
from app.sync.change_log import lock_owner, record_domain_change
from fastapi import HTTPException
from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .google_calendar_models import (
    GoogleCalendarConnection,
    GoogleCalendarCredential,
    GoogleCalendarOAuthState,
)
from .google_calendar_oauth import (
    access_token,
    authorize_calendar,
    google_calendar_request,
)
from .google_calendar_projection import validate_google_recurrence
from .recurrence import utc

MAX_PAGES = 100
MAX_ITEMS = 10_000
NETWORK_TIMEOUT_SECONDS = 90
LEASE_DURATION = timedelta(minutes=10)
SYNC_INTERVAL = timedelta(minutes=15)
logger = logging.getLogger(__name__)
_FIELDS = ('title', 'description', 'starts_at', 'ends_at', 'timezone', 'all_day', 'rrule', 'external_metadata')
_ERRORS = {'CALENDAR_RECONNECT_REQUIRED', 'CALENDAR_SCOPE_REQUIRED', 'CALENDAR_NOT_CONFIGURED',
    'CALENDAR_SYNC_EXPIRED', 'CALENDAR_UNAVAILABLE', 'CALENDAR_INVALID_DATA', 'CALENDAR_SYNC_LIMIT',
    'CALENDAR_SYNC_BUSY', 'CALENDAR_NOT_CONNECTED', 'POLICY_DENIED'}


def _error(code: str, status: int = 409) -> HTTPException:
    return HTTPException(status, detail={'code': code, 'message': 'Google Calendar import could not be completed.'})


@dataclass(frozen=True)
class _Claim:
    connection_id: str
    owner_id: str
    version: int
    lease: str
    calendar_id: str
    timezone: str
    encrypted_cursor: str | None


@dataclass(frozen=True)
class _Event:
    remote_id: str
    cancelled: bool
    values: dict[str, Any]
    metadata: dict[str, Any]


async def _claim(connection_id: str, owner_id: str | None, at: datetime, force: bool) -> _Claim:
    async with database.SessionLocal() as db:
        conn = await db.get(GoogleCalendarConnection, connection_id)
        if conn is None or conn.deleted_at or (owner_id is not None and conn.owner_id != owner_id):
            raise _error('CALENDAR_NOT_CONNECTED', 404)
        if conn.connection_status == 'disconnected':
            raise _error('CALENDAR_NOT_CONNECTED', 404)
        authorize_calendar(conn.owner_id, 'calendar.import')
        lease = str(uuid4())
        conditions = [GoogleCalendarConnection.id == conn.id, GoogleCalendarConnection.owner_id == conn.owner_id,
            GoogleCalendarConnection.version == conn.version, GoogleCalendarConnection.deleted_at.is_(None),
            GoogleCalendarConnection.connection_status != 'disconnected',
            or_(GoogleCalendarConnection.lease_owner.is_(None), GoogleCalendarConnection.lease_expires_at <= at)]
        if not force:
            conditions.extend([GoogleCalendarConnection.connection_status == 'connected',
                or_(GoogleCalendarConnection.last_attempt_at.is_(None), GoogleCalendarConnection.last_attempt_at <= at - SYNC_INTERVAL)])
        saved = await db.execute(update(GoogleCalendarConnection).where(*conditions).values(
            lease_owner=lease, lease_expires_at=at + LEASE_DURATION, last_attempt_at=at,
            connection_status='connected', version=conn.version + 1).execution_options(synchronize_session=False))
        if int(getattr(saved, 'rowcount', 0) or 0) != 1:
            raise _error('CALENDAR_SYNC_BUSY')
        claim = _Claim(conn.id, conn.owner_id, conn.version + 1, lease,
            conn.calendar_id, conn.calendar_timezone, conn.encrypted_sync_token)
        await db.commit()
        return claim


def _instant(value: dict[str, Any], fallback_timezone: str) -> tuple[datetime, bool, str]:
    zone_name = value.get('timeZone', fallback_timezone)
    if not isinstance(zone_name, str) or len(zone_name) > 64:
        raise ValueError('Invalid timezone')
    zone = ZoneInfo(zone_name)
    if 'dateTime' in value and 'date' not in value:
        stamp = datetime.fromisoformat(value['dateTime'])
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=zone)
        return utc(stamp), False, zone_name
    if 'date' in value and 'dateTime' not in value:
        day = date.fromisoformat(value['date'])
        return utc(datetime.combine(day, time.min, zone)), True, zone_name
    raise ValueError('Missing event instant')


def _parse_event(raw: Any, timezone_name: str) -> _Event:
    if not isinstance(raw, dict):
        raise TypeError('Invalid event')
    remote_id = raw.get('id')
    if not isinstance(remote_id, str) or not 1 <= len(remote_id) <= 1024:
        raise ValueError('Invalid event identifier')
    cancelled = raw.get('status') == 'cancelled'
    metadata: dict[str, Any] = {}
    parent = raw.get('recurringEventId')
    if parent is not None:
        if not isinstance(parent, str) or not 1 <= len(parent) <= 1024:
            raise ValueError('Invalid series identifier')
        original, _, _ = _instant(raw['originalStartTime'], timezone_name)
        metadata.update(recurring_event_id=parent, original_start=original.isoformat())
    elif 'originalStartTime' in raw:
        raise ValueError('Missing series identifier')
    if cancelled and ('start' not in raw or 'end' not in raw):
        if parent is None:
            return _Event(remote_id, True, {}, metadata)
        original = datetime.fromisoformat(metadata['original_start'])
        values: dict[str, Any] = {'title': '(Cancelled)', 'description': '', 'starts_at': original,
            'ends_at': original + timedelta(seconds=1), 'timezone': timezone_name, 'all_day': False, 'rrule': None}
    else:
        start, all_day, zone_name = _instant(raw['start'], timezone_name)
        end, end_all_day, _ = _instant(raw['end'], zone_name)
        if start >= end or all_day != end_all_day:
            raise ValueError('Invalid event interval')
        title, description = raw.get('summary') or '(Untitled)', raw.get('description', '')
        if not isinstance(title, str) or not isinstance(description, str) or len(description) > 10_000:
            raise ValueError('Invalid event text')
        recurrence = raw.get('recurrence', [])
        if not isinstance(recurrence, list) or any(not isinstance(line, str) for line in recurrence):
            raise ValueError('Invalid recurrence')
        validate_google_recurrence(recurrence, start, zone_name)
        if recurrence:
            metadata['recurrence'] = recurrence
        first_rule = next((line.removeprefix('RRULE:') for line in recurrence if line.startswith('RRULE:')), None)
        if first_rule is not None and len(first_rule) > 500:
            raise ValueError('Recurrence rule limit exceeded')
        values = {'title': title[:300], 'description': description, 'starts_at': start,
            'ends_at': end, 'timezone': zone_name, 'all_day': all_day, 'rrule': first_rule}
    values['external_metadata'] = metadata
    return _Event(remote_id, cancelled, values, metadata)


async def _fetch(claim: _Claim, token: str, cursor: str | None) -> tuple[list[_Event], str, str]:
    params: dict[str, Any] = {'singleEvents': 'false', 'showDeleted': 'true', 'maxResults': 2500}
    if cursor:
        params['syncToken'] = cursor
    items: list[_Event] = []
    seen: set[str] = set()
    page_tokens: set[str] = set()
    timezone_name = claim.timezone
    for _ in range(MAX_PAGES):
        authorize_calendar(claim.owner_id, 'calendar.import', external=True)
        page = await google_calendar_request('GET',
            f'https://www.googleapis.com/calendar/v3/calendars/{quote(claim.calendar_id, safe="")}/events',
            headers={'Authorization': f'Bearer {token}'}, params=dict(params))
        try:
            zone_name = page.get('timeZone', timezone_name)
            if not isinstance(zone_name, str) or len(zone_name) > 64:
                raise ValueError('Invalid calendar timezone')
            ZoneInfo(zone_name)
            timezone_name = zone_name
            raw_items = page.get('items', [])
            if not isinstance(raw_items, list):
                raise TypeError('Invalid event collection')
            if len(items) + len(raw_items) > MAX_ITEMS:
                raise _error('CALENDAR_SYNC_LIMIT', 422)
            for raw in raw_items:
                event = _parse_event(raw, timezone_name)
                if event.remote_id in seen:
                    raise ValueError('Duplicate event identity')
                items.append(event); seen.add(event.remote_id)
            following = page.get('nextPageToken')
            if following is not None:
                if not isinstance(following, str) or not 1 <= len(following) <= 8192 or following in page_tokens:
                    raise ValueError('Invalid page cursor')
                page_tokens.add(following); params['pageToken'] = following
                continue
            next_cursor = page.get('nextSyncToken')
            if not isinstance(next_cursor, str) or not 1 <= len(next_cursor) <= 8192:
                raise ValueError('Missing final sync cursor')
            return items, next_cursor, timezone_name
        except (ValueError, TypeError, KeyError, ZoneInfoNotFoundError, OverflowError):
            raise _error('CALENDAR_INVALID_DATA', 422) from None
    raise _error('CALENDAR_SYNC_LIMIT', 422)


async def _write(db: AsyncSession, event: CalendarEvent, values: dict[str, Any]) -> None:
    previous = event.version
    saved = await db.execute(update(CalendarEvent).where(CalendarEvent.id == event.id,
        CalendarEvent.owner_id == event.owner_id, CalendarEvent.version == previous)
        .values(**values, version=previous + 1).execution_options(synchronize_session=False))
    if int(getattr(saved, 'rowcount', 0) or 0) != 1:
        raise _error('CALENDAR_SYNC_BUSY')
    await db.refresh(event)
    await record_domain_change(db, event)


def _same(event: CalendarEvent, values: dict[str, Any]) -> bool:
    return all((utc(getattr(event, name)) if name in {'starts_at', 'ends_at'} else getattr(event, name)) == values[name]
        for name in _FIELDS)


async def _apply(claim: _Claim, events: list[_Event], cursor: str, timezone_name: str,
                 at: datetime, full: bool) -> dict[str, Any]:
    async with database.SessionLocal() as db:
        authorize_calendar(claim.owner_id, 'calendar.import')
        await lock_owner(db, claim.owner_id)
        conn = (await db.execute(select(GoogleCalendarConnection).where(
            GoogleCalendarConnection.id == claim.connection_id,
            GoogleCalendarConnection.owner_id == claim.owner_id).with_for_update())).scalar_one_or_none()
        if (conn is None or conn.deleted_at or conn.connection_status != 'connected'
                or conn.lease_owner != claim.lease or conn.version != claim.version):
            raise _error('CALENDAR_SYNC_BUSY')
        source = f'google_calendar:{conn.id}'
        existing = {event.external_id: event for event in (await db.execute(select(CalendarEvent).where(
            CalendarEvent.owner_id == claim.owner_id, CalendarEvent.external_source == source))).scalars()}
        seen = {event.remote_id for event in events}
        missing = {key for key in existing if key not in seen} if full else set()
        cancelled_masters = {event.remote_id for event in events if event.cancelled and not event.metadata.get('recurring_event_id')}
        cancelled_masters.update(key for key in missing if key is not None)
        imported = deleted = 0
        for fetched in sorted(events, key=lambda event: bool(event.metadata.get('recurring_event_id'))):
            event = existing.get(fetched.remote_id)
            if event is not None and event.owner_id != conn.owner_id:
                raise _error('CALENDAR_INVALID_DATA', 422)
            parent = fetched.metadata.get('recurring_event_id')
            master = existing.get(parent) if parent else None
            cancelled = fetched.cancelled or bool(parent and (parent in cancelled_masters or (master and master.deleted_at)))
            if event is None:
                if not fetched.values:
                    continue  # Google guarantees only the ID for unknown standalone cancellations.
                event = CalendarEvent(id=str(uuid5(NAMESPACE_URL, f'aelys:{conn.owner_id}:{source}:{fetched.remote_id}')),
                    owner_id=conn.owner_id, version=1, external_source=source,
                    external_id=fetched.remote_id, deleted_at=at if cancelled else None, **fetched.values)
                db.add(event)
                await db.flush()
                await record_domain_change(db, event)
                existing[fetched.remote_id] = event
                deleted += int(cancelled); imported += int(not cancelled)
            elif cancelled:
                values: dict[str, Any] = {}
                if fetched.metadata.get('recurring_event_id') and event.external_metadata != fetched.metadata:
                    values['external_metadata'] = fetched.metadata
                if event.deleted_at is None:
                    values['deleted_at'] = at
                if values:
                    await _write(db, event, values)
                    deleted += 1
            elif event.deleted_at is not None or not _same(event, fetched.values):
                await _write(db, event, {**fetched.values, 'deleted_at': None})
                imported += 1
        for remote_id, event in existing.items():
            parent = (event.external_metadata or {}).get('recurring_event_id')
            changes: dict[str, Any] = {}
            if remote_id in missing and parent:
                # A vanished exception in a successful full snapshot no longer
                # suppresses the master's original occurrence, even if already deleted.
                changes['external_metadata'] = {key: value for key, value in event.external_metadata.items()
                    if key not in {'recurring_event_id', 'original_start'}}
            if event.deleted_at is None and (remote_id in missing or parent in cancelled_masters):
                changes['deleted_at'] = at
            if changes:
                await _write(db, event, changes)
                deleted += 1
        for event in existing.values():
            if await db.get(SyncRecord, (claim.owner_id, 'event', event.id)) is None:
                # Identical pre-upgrade imports still need a shared projection;
                # indexing must not invent a new domain version or history.
                await record_domain_change(db, event)
        conn.encrypted_sync_token = encrypt_secret(cursor)
        conn.calendar_timezone, conn.last_synced_at = timezone_name, at
        conn.connection_status, conn.last_error_code = 'connected', None
        conn.lease_owner = conn.lease_expires_at = None
        conn.version += 1
        await db.commit()
        return {'imported': imported, 'deleted': deleted, 'full_sync': full}


async def _mark_error(claim: _Claim, code: str) -> None:
    async with database.SessionLocal() as db:
        authorize_calendar(claim.owner_id, 'calendar.import')
        await db.execute(update(GoogleCalendarConnection).where(
            GoogleCalendarConnection.id == claim.connection_id, GoogleCalendarConnection.owner_id == claim.owner_id,
            GoogleCalendarConnection.version == claim.version, GoogleCalendarConnection.lease_owner == claim.lease,
            GoogleCalendarConnection.connection_status != 'disconnected', GoogleCalendarConnection.deleted_at.is_(None))
            .values(connection_status='error' if code in {'CALENDAR_RECONNECT_REQUIRED', 'CALENDAR_SCOPE_REQUIRED'} else 'connected',
                last_error_code=code, lease_owner=None, lease_expires_at=None,
                version=claim.version + 1).execution_options(synchronize_session=False))
        await db.commit()


async def sync_google_calendar(connection_id: str, owner_id: str | None = None, *,
                               at: datetime | None = None, force: bool = True) -> dict[str, Any]:
    instant = utc(at or datetime.now(UTC))
    claim = await _claim(connection_id, owner_id, instant, force)
    try:
        async with asyncio.timeout(NETWORK_TIMEOUT_SECONDS):
            async with database.SessionLocal() as db:
                conn = await db.get(GoogleCalendarConnection, connection_id)
                if conn is None or conn.lease_owner != claim.lease or conn.version != claim.version:
                    raise _error('CALENDAR_SYNC_BUSY')
                token = await access_token(db, conn)
                await db.commit()  # Credential refresh is durable before fetching; no owner lock spans I/O.
            cursor = decrypt_secret(claim.encrypted_cursor) if claim.encrypted_cursor else None
            full = cursor is None
            try:
                events, next_cursor, zone_name = await _fetch(claim, token, cursor)
            except HTTPException as exc:
                if not cursor or not isinstance(exc.detail, dict) or exc.detail.get('code') != 'CALENDAR_SYNC_EXPIRED':
                    raise
                events, next_cursor, zone_name = await _fetch(claim, token, None)
                full = True
        # The network deadline never cancels a domain transaction halfway through apply.
        return await _apply(claim, events, next_cursor, zone_name, instant, full)
    except Exception as exc:  # noqa: BLE001 - preserve previous data; never expose provider payloads/URLs
        code = exc.detail.get('code') if isinstance(exc, HTTPException) and isinstance(exc.detail, dict) else None
        code = code if isinstance(code, str) and code in _ERRORS else 'CALENDAR_UNAVAILABLE'
        await _mark_error(claim, code)
        raise _error(code, exc.status_code if isinstance(exc, HTTPException) else 502) from None


async def disconnect_google_calendar(db: AsyncSession, conn: GoogleCalendarConnection) -> None:
    """Flush-only: caller commits/rolls back tombstones, tokens and connection together."""
    authorize_calendar(conn.owner_id, 'calendar.connect')
    await lock_owner(db, conn.owner_id)
    await db.refresh(conn)
    events = (await db.execute(select(CalendarEvent).where(CalendarEvent.owner_id == conn.owner_id,
        CalendarEvent.external_source == f'google_calendar:{conn.id}', CalendarEvent.deleted_at.is_(None)))).scalars()
    instant = datetime.now(UTC)
    for event in events:
        await _write(db, event, {'deleted_at': instant})
    await db.execute(delete(GoogleCalendarCredential).where(GoogleCalendarCredential.connection_id == conn.id))
    await db.execute(delete(GoogleCalendarOAuthState).where(GoogleCalendarOAuthState.owner_id == conn.owner_id))
    conn.encrypted_sync_token = None
    conn.connection_status, conn.last_error_code = 'disconnected', None
    conn.lease_owner = conn.lease_expires_at = None
    conn.version += 1
    await db.flush()


async def sync_due_google_calendars(at: datetime | None = None) -> None:
    """One bounded connector step; each connection failure is isolated."""
    instant = utc(at or datetime.now(UTC))
    async with database.SessionLocal() as db:
        ids = list((await db.execute(select(GoogleCalendarConnection.id).where(
            GoogleCalendarConnection.deleted_at.is_(None), GoogleCalendarConnection.connection_status == 'connected',
            or_(GoogleCalendarConnection.last_attempt_at.is_(None), GoogleCalendarConnection.last_attempt_at <= instant - SYNC_INTERVAL),
            or_(GoogleCalendarConnection.lease_owner.is_(None), GoogleCalendarConnection.lease_expires_at <= instant))
            .order_by(GoogleCalendarConnection.last_attempt_at, GoogleCalendarConnection.id).limit(20))).scalars())
    for connection_id in ids:
        try:
            await sync_google_calendar(connection_id, at=instant, force=False)
        except Exception:  # noqa: BLE001 - one failed connection must not kill the worker
            logger.info('Google Calendar sync attempt unavailable')
