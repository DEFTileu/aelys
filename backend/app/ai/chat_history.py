"""Backward pages of the owner's persisted personal Telegram dialogue."""
from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime
from typing import Any
from uuid import UUID

from app.core.models import AIConversation, AIMessage, AIRun, AIRunEvent
from app.domains.recurrence import utc
from app.integrations.telegram_models import TelegramIntegration, TelegramPersonalJob
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    ValidationError,
    field_validator,
    model_validator,
)
from sqlalchemy import and_, func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

HISTORY_TOOL = 'read_chat_history'
HISTORY_SCOPE = 'chat.history.read'
MAX_HISTORY_MESSAGES = 100
MAX_MESSAGE_CHARS = 1200
MAX_PAGE_BYTES = 24_000


class HistoryQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')

    start_at: AwareDatetime | None = Field(default=None, description='Inclusive ISO 8601 timestamp with offset')
    end_at: AwareDatetime | None = Field(default=None, description='Exclusive ISO 8601 timestamp with offset')
    before_message_id: UUID | None = Field(default=None, description='Exclusive cursor returned by the previous page')
    limit: StrictInt = Field(default=20, ge=1, le=MAX_HISTORY_MESSAGES)

    @field_validator('start_at', 'end_at', mode='before')
    @classmethod
    def require_timestamp(cls, value: object) -> object:
        if value is None or isinstance(value, datetime):
            return value
        if not isinstance(value, str) or not 16 <= len(value) <= 48 or 'T' not in value:
            raise ValueError('Use an ISO 8601 timestamp with an offset')
        return value

    @model_validator(mode='after')
    def normalize_period(self) -> HistoryQuery:
        if self.start_at is None and self.end_at is None and self.before_message_id is not None:
            return self
        if self.start_at is None or self.end_at is None:
            raise ValueError('Supply both period bounds or a before_message_id')
        self.start_at, self.end_at = utc(self.start_at), utc(self.end_at)
        if self.start_at >= self.end_at:
            raise ValueError('History start must precede the end')
        return self


def history_event_query(arguments: object) -> dict[str, str]:
    """Reconstruct trace metadata from validated fields only."""
    try:
        query = HistoryQuery.model_validate(arguments)
    except (ValidationError, OverflowError):
        return {}
    metadata: dict[str, str] = {}
    if query.start_at and query.end_at:
        metadata.update(start_at=query.start_at.isoformat(), end_at=query.end_at.isoformat())
    if query.before_message_id is not None:
        metadata['before_message_id'] = str(query.before_message_id)
    return metadata


def _eligible_messages(owner_id: str, integration_id: str, current_prompt_id: str):
    job = TelegramPersonalJob
    completion = AIRunEvent
    personal_runs = (
        select(AIRun.id.label('run_id'), AIRun.conversation_id, AIRun.prompt_message_id,
               AIRun.started_at, AIRun.completed_at)
        .join(job, and_(job.run_id == AIRun.id, job.conversation_id == AIRun.conversation_id))
        .join(TelegramIntegration, TelegramIntegration.id == job.integration_id)
        .where(
            AIRun.owner_id == owner_id, AIRun.status == 'completed', AIRun.deleted_at.is_(None),
            job.owner_id == owner_id, job.integration_id == integration_id,
            job.state == 'done', job.deleted_at.is_(None),
            TelegramIntegration.owner_id == owner_id, TelegramIntegration.deleted_at.is_(None),
        ).cte('history_personal_runs')
    )
    modern_reply_id = completion.payload['reply_message_id'].as_string()
    prompt_matches = select(personal_runs.c.run_id).where(
        personal_runs.c.conversation_id == AIMessage.conversation_id,
        personal_runs.c.prompt_message_id == AIMessage.id,
    ).exists()

    # Legacy Telegram replies were inserted immediately after setting completed_at,
    # before the completion event. Trust a single candidate in that interval only
    # when no other channel's run could have produced it.
    same_interval = aliased(AIMessage)
    legacy_candidates = select(func.count()).select_from(same_interval).where(
        same_interval.conversation_id == personal_runs.c.conversation_id,
        same_interval.role == 'assistant',
        same_interval.created_at >= personal_runs.c.completed_at,
        same_interval.created_at <= completion.created_at,
    ).correlate(personal_runs, completion).scalar_subquery()
    other_run = aliased(AIRun)
    overlapping_run = select(other_run.id).where(
        other_run.conversation_id == personal_runs.c.conversation_id,
        other_run.id != personal_runs.c.run_id,
        other_run.started_at <= completion.created_at,
        or_(other_run.completed_at.is_(None), other_run.completed_at >= personal_runs.c.started_at),
    ).correlate(personal_runs, completion).exists()
    reply_matches = (
        select(personal_runs.c.run_id)
        .join(completion, completion.run_id == personal_runs.c.run_id)
        .where(
            personal_runs.c.conversation_id == AIMessage.conversation_id,
            completion.event_type == 'ai.run.completed',
            or_(
                modern_reply_id == AIMessage.id,
                and_(
                    modern_reply_id.is_(None),
                    AIMessage.created_at >= personal_runs.c.completed_at,
                    AIMessage.created_at <= completion.created_at,
                    legacy_candidates == 1,
                    ~overlapping_run,
                ),
            ),
        ).exists()
    )
    return select(AIMessage).join(AIConversation, AIConversation.id == AIMessage.conversation_id).where(
        AIConversation.owner_id == owner_id, AIConversation.deleted_at.is_(None),
        AIMessage.id != current_prompt_id,
        or_(and_(AIMessage.role == 'user', prompt_matches), and_(AIMessage.role == 'assistant', reply_matches)),
    )


def history_memory_refs(value: object) -> tuple[tuple[str, int], ...]:
    """Accept only well-formed server-side memory references."""
    if not isinstance(value, (list, tuple)):
        return ()
    refs: set[tuple[str, int]] = set()
    for ref in value:
        if not isinstance(ref, (list, tuple)) or len(ref) != 2:
            continue
        fact_id, version = ref
        if isinstance(fact_id, str) and 1 <= len(fact_id) <= 36 and type(version) is int and version > 0:
            refs.add((fact_id, version))
    return tuple(sorted(refs))


async def read_chat_history(
    db: AsyncSession, owner_id: str, integration_id: str, current_prompt_id: str,
    arguments: Mapping[str, Any],
) -> Mapping[str, Any]:
    from .chat_support import filter_history_messages

    args = HistoryQuery.model_validate(arguments)
    integration = await db.scalar(select(TelegramIntegration.id).where(
        TelegramIntegration.id == integration_id, TelegramIntegration.owner_id == owner_id,
        TelegramIntegration.deleted_at.is_(None),
    ))
    if integration is None:
        return {'error': 'HISTORY_UNAVAILABLE: Personal Telegram history unavailable', 'untrusted': True}

    eligible = _eligible_messages(owner_id, integration_id, current_prompt_id)
    page = eligible
    if args.start_at is not None and args.end_at is not None:
        page = page.where(AIMessage.created_at >= args.start_at, AIMessage.created_at < args.end_at)
    if args.before_message_id is not None:
        cursor = (await db.execute(eligible.with_only_columns(AIMessage.created_at, AIMessage.id)
                                   .where(AIMessage.id == str(args.before_message_id)))).one_or_none()
        if cursor is None:
            return {'error': 'INVALID_CURSOR: History cursor unavailable', 'untrusted': True}
        page = page.where(tuple_(AIMessage.created_at, AIMessage.id) < tuple_(cursor.created_at, cursor.id))

    rows = list(await db.scalars(page.order_by(AIMessage.created_at.desc(), AIMessage.id.desc()).limit(args.limit + 1)))
    candidates = rows[:args.limit]
    memory_refs: dict[str, tuple[tuple[str, int], ...]] = {}
    visible = {message.id for message in await filter_history_messages(db, owner_id, candidates, memory_refs_out=memory_refs)}
    messages: list[dict[str, Any]] = []
    refs: set[tuple[str, int]] = set()
    remaining_bytes = MAX_PAGE_BYTES
    consumed = 0
    for message in candidates:
        if message.id in visible:
            entry = {
                'id': message.id, 'role': message.role, 'created_at': utc(message.created_at).isoformat(),
                'content': message.content[:MAX_MESSAGE_CHARS],
                'truncated': len(message.content) > MAX_MESSAGE_CHARS,
            }
            size = len(json.dumps(entry, ensure_ascii=False).encode('utf-8')) + 2
            if size > remaining_bytes:
                break
            messages.append(entry)
            remaining_bytes -= size
            refs.update(memory_refs.get(message.id, ()))
        consumed += 1
    return {
        'messages': messages, 'untrusted': True,
        'next_before_message_id': rows[consumed - 1].id if 0 < consumed < len(rows) else None,
        'memory_refs': tuple(sorted(refs)),
    }
