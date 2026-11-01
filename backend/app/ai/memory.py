"""Flush-only explicit owner memory, without extraction, embeddings or grants.

Callers authenticate the owner and authorize the explicit owner request. This
service independently checks memory policy on every entry point; fact contents
never enter the permission context or policy arguments. Callers mark returned
facts as untrusted data when constructing a model prompt.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime

from app.core.models import User, now
from app.domains.recurrence import utc
from fastapi import HTTPException
from sqlalchemy import or_, select, update
from sqlalchemy import text as sql_text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from .memory_models import OwnerMemoryFact
from .models import PermissionContext, ToolCall
from .policy import ServerPolicyEngine

KINDS = frozenset({'preference', 'fact', 'goal', 'context'})
MAX_TEXT = 2000
MAX_QUERY_TOKENS = 100
READ_BATCH = 200


@dataclass
class _MemoryPolicy:
    name: str
    required_scope: str
    external_effect: bool = False


def _authorize(owner_id: str, scope: str) -> None:
    ServerPolicyEngine().authorize(_MemoryPolicy(scope, scope), ToolCall(scope, {}),
        PermissionContext(actor=f'owner:{owner_id}', scopes=frozenset({scope}), policy_id='owner-memory'))


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={'code': code, 'message': message})


def _normalize(value: str) -> str:
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def _validate_text(value: str) -> None:
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_TEXT or not _normalize(value):
        raise _error(422, 'VALIDATION_ERROR', 'Memory text must contain 1 to 2000 characters')


def normalized_memory_hash(owner_id: str, text: str) -> str:
    """Owner-bound portable digest; normalization never changes the stored text."""
    _validate_text(text)
    encoded = json.dumps([owner_id, _normalize(text)], ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _kind(kind: str) -> None:
    if not isinstance(kind, str) or kind not in KINDS:
        raise _error(422, 'VALIDATION_ERROR', 'Invalid memory kind')


def _instant(value: datetime | None) -> datetime:
    if value is not None and not isinstance(value, datetime):
        raise _error(422, 'VALIDATION_ERROR', 'Memory date must be a datetime')
    return utc(value if value is not None else now())


def _expires(value: datetime | None) -> datetime | None:
    return _instant(value) if value is not None else None


def _version(value: int | None) -> None:
    if value is not None and (type(value) is not int or value < 1):
        raise _error(422, 'VALIDATION_ERROR', 'Memory version must be a positive integer')


async def _lock_owner(db: AsyncSession, owner_id: str) -> None:
    # All memory writes lock before reading. SQLite's no-op owner UPDATE obtains
    # a write reservation too; FOR UPDATE alone would not serialize its writers.
    with db.no_autoflush:
        if db.get_bind().dialect.name == 'postgresql':
            await db.execute(sql_text('SELECT pg_advisory_xact_lock(hashtext(:key))'), {'key': f'sync-owner:{owner_id}'})
            found = (await db.execute(select(User.id).where(User.id == owner_id))).scalar_one_or_none()
        else:
            found = (await db.execute(update(User).where(User.id == owner_id).values(id=User.id)
                .returning(User.id).execution_options(synchronize_session=False))).scalar_one_or_none()
    if found is None:
        raise _error(404, 'NOT_FOUND', 'Owner not found')


def _active(at: datetime):
    return (OwnerMemoryFact.deleted_at.is_(None), or_(OwnerMemoryFact.expires_at.is_(None), OwnerMemoryFact.expires_at > at))


def _utc_dates(fact: OwnerMemoryFact) -> OwnerMemoryFact:
    # SQLite drops timezone metadata. Restore UTC without making a read dirty
    # or causing an otherwise-idempotent remember to churn updated_at/version.
    for field in ('created_at', 'updated_at', 'deleted_at', 'expires_at'):
        value = getattr(fact, field)
        if value is not None:
            set_committed_value(fact, field, utc(value))
    return fact


async def _owned(db: AsyncSession, owner_id: str, fact_id: str) -> OwnerMemoryFact:
    fact = (await db.execute(select(OwnerMemoryFact).where(
        OwnerMemoryFact.id == fact_id, OwnerMemoryFact.owner_id == owner_id,
    ).execution_options(populate_existing=True))).scalar_one_or_none()
    if fact is None:
        raise _error(404, 'NOT_FOUND', 'Memory fact not found')
    return _utc_dates(fact)


async def remember(db: AsyncSession, owner_id: str, text: str, *, kind: str = 'fact',
                   source: str = 'api', source_message_id: str | None = None,
                   expires_at: datetime | None = None) -> OwnerMemoryFact:
    _authorize(owner_id, 'memory.write')
    digest = normalized_memory_hash(owner_id, text)
    _kind(kind)
    if not isinstance(source, str) or not 1 <= len(source) <= 32:
        raise _error(422, 'VALIDATION_ERROR', 'Memory source must contain 1 to 32 characters')
    if source_message_id is not None and (not isinstance(source_message_id, str) or not 1 <= len(source_message_id) <= 100):
        raise _error(422, 'VALIDATION_ERROR', 'Invalid memory source message ID')
    expiry = _expires(expires_at)
    await _lock_owner(db, owner_id)
    fact = (await db.execute(select(OwnerMemoryFact).where(
        OwnerMemoryFact.owner_id == owner_id, OwnerMemoryFact.normalized_hash == digest,
    ).execution_options(populate_existing=True))).scalar_one_or_none()
    if fact is not None:
        if fact.deleted_at is None and (fact.expires_at is None or utc(fact.expires_at) > _instant(None)):
            return _utc_dates(fact)
        fact.text, fact.kind, fact.source, fact.source_message_id = text, kind, source, source_message_id
        fact.expires_at, fact.deleted_at = expiry, None
        fact.version += 1
    else:
        fact = OwnerMemoryFact(owner_id=owner_id, text=text, kind=kind, source=source,
            source_message_id=source_message_id, expires_at=expiry, normalized_hash=digest)
        db.add(fact)
    await db.flush()
    return _utc_dates(fact)


async def update_fact(db: AsyncSession, owner_id: str, fact_id: str, version: int, *,
                      text: str, kind: str, expires_at: datetime | None) -> OwnerMemoryFact:
    _authorize(owner_id, 'memory.write')
    _version(version)
    if version is None:
        raise _error(422, 'VALIDATION_ERROR', 'Memory version is required')
    digest = normalized_memory_hash(owner_id, text)
    _kind(kind)
    expiry = _expires(expires_at)
    await _lock_owner(db, owner_id)
    fact = await _owned(db, owner_id, fact_id)
    if fact.deleted_at is not None:
        raise _error(404, 'NOT_FOUND', 'Memory fact not found')
    if fact.version != version:
        raise _error(409, 'VERSION_CONFLICT', 'Memory fact changed; refresh before editing')
    duplicate = (await db.execute(select(OwnerMemoryFact.id).where(
        OwnerMemoryFact.owner_id == owner_id, OwnerMemoryFact.normalized_hash == digest, OwnerMemoryFact.id != fact_id,
    ))).scalar_one_or_none()
    if duplicate is not None:
        # Historical rows also reserve their normalized hash. Explicit remember
        # revives that row rather than silently destroying its provenance.
        raise _error(409, 'MEMORY_DUPLICATE', 'This memory fact already exists')
    result = await db.execute(update(OwnerMemoryFact).where(
        OwnerMemoryFact.id == fact_id, OwnerMemoryFact.owner_id == owner_id,
        OwnerMemoryFact.version == version, OwnerMemoryFact.deleted_at.is_(None),
    ).values(text=text, kind=kind, expires_at=expiry, normalized_hash=digest, version=version + 1)
        .execution_options(synchronize_session=False))
    if int(getattr(result, 'rowcount', 0) or 0) != 1:
        raise _error(409, 'VERSION_CONFLICT', 'Memory fact changed; refresh before editing')
    await db.flush()
    await db.refresh(fact)
    return _utc_dates(fact)


async def forget(db: AsyncSession, owner_id: str, *, fact_id: str | None = None,
                 text: str | None = None, version: int | None = None) -> OwnerMemoryFact | None:
    _authorize(owner_id, 'memory.write')
    _version(version)
    if (fact_id is None) == (text is None):
        raise _error(422, 'VALIDATION_ERROR', 'Supply a memory ID or text')
    digest = normalized_memory_hash(owner_id, text) if text is not None else None
    await _lock_owner(db, owner_id)
    fact: OwnerMemoryFact | None
    if fact_id is not None:
        fact = await _owned(db, owner_id, fact_id)
    else:
        fact = (await db.execute(select(OwnerMemoryFact).where(
            OwnerMemoryFact.owner_id == owner_id, OwnerMemoryFact.normalized_hash == digest,
        ).execution_options(populate_existing=True))).scalar_one_or_none()
    if fact is None:
        return None
    if version is not None and fact.version != version:
        raise _error(409, 'VERSION_CONFLICT', 'Memory fact changed; refresh before forgetting')
    if fact.deleted_at is None:
        fact.deleted_at = now()
        fact.version += 1
        await db.flush()
    return _utc_dates(fact)


def _tokens(query: str) -> set[str]:
    return set(re.findall(r'[^\W_]{2,}', _normalize(query)))


def _query(query: str | None) -> set[str] | None:
    if query is None:
        return None
    if not isinstance(query, str) or len(query) > MAX_TEXT:
        raise _error(422, 'VALIDATION_ERROR', 'Memory query must contain at most 2000 characters')
    # Preserve token order for a deterministic first-100 budget, even with repeats.
    unique = dict.fromkeys(re.findall(r'[^\W_]{2,}', _normalize(query)))
    return set(list(unique)[:MAX_QUERY_TOKENS])


async def _batches(db: AsyncSession, owner_id: str, at: datetime) -> AsyncIterator[list[OwnerMemoryFact]]:
    after = ''
    while True:
        rows = list((await db.execute(select(OwnerMemoryFact).where(
            OwnerMemoryFact.owner_id == owner_id, OwnerMemoryFact.id > after, *_active(at),
        ).order_by(OwnerMemoryFact.id).limit(READ_BATCH))).scalars())
        if not rows:
            return
        after = rows[-1].id
        yield [_utc_dates(fact) for fact in rows]
        if len(rows) < READ_BATCH:
            return


async def list_memory(db: AsyncSession, owner_id: str, *, at: datetime | None = None,
                      limit: int = 100, query: str | None = None) -> list[OwnerMemoryFact]:
    _authorize(owner_id, 'memory.read')
    if type(limit) is not int or not 1 <= limit <= 200:
        raise _error(422, 'VALIDATION_ERROR', 'Memory limit must be between 1 and 200')
    tokens = _query(query)
    instant = _instant(at)
    result: list[OwnerMemoryFact] = []
    async for rows in _batches(db, owner_id, instant):
        for fact in rows:
            if tokens is None or (tokens and tokens & _tokens(fact.text)):
                result.append(fact)
                if len(result) == limit:
                    return result
    return result


async def select_relevant_facts(db: AsyncSession, owner_id: str, query: str, *,
                                at: datetime | None = None) -> list[OwnerMemoryFact]:
    _authorize(owner_id, 'memory.read')
    tokens = _query(query)
    instant = _instant(at)
    if not tokens:
        return []
    best: list[tuple[int, str, OwnerMemoryFact]] = []
    async for rows in _batches(db, owner_id, instant):
        for fact in rows:
            score = len(tokens & _tokens(fact.text))
            if score:
                best.append((score, fact.id, fact))
        best = sorted(best, key=lambda entry: (-entry[0], entry[1]))[:10]
    return [fact for _, _, fact in best]


async def active_memory_versions(db: AsyncSession, owner_id: str, ids: set[str], *,
                                 at: datetime | None = None) -> dict[str, int]:
    """Validate bounded history provenance without loading or returning fact text."""
    _authorize(owner_id, 'memory.read')
    if (not isinstance(ids, set) or len(ids) > 200
            or any(not isinstance(fact_id, str) or not 1 <= len(fact_id) <= 36 for fact_id in ids)):
        raise _error(422, 'VALIDATION_ERROR', 'Supply at most 200 memory IDs')
    instant = _instant(at)
    if not ids:
        return {}
    rows = (await db.execute(select(OwnerMemoryFact.id, OwnerMemoryFact.version).where(
        OwnerMemoryFact.owner_id == owner_id, OwnerMemoryFact.id.in_(ids), *_active(instant),
    ))).all()
    return {fact_id: version for fact_id, version in rows}
