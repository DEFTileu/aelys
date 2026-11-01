"""Encrypted personal ingestion and durable claims; no model/tool execution.

Only connector startup calls fail_interrupted_personal_jobs. Running work is
terminal after a restart: neither tools nor an ambiguous recovery DM replay.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from app.ai.crypto import decrypt_secret
from app.ai.errors import PolicyDenied
from app.core import db as database
from app.core.models import AIConversation, AIRun, Notification, now
from app.domains.recurrence import utc
from sqlalchemy import exists, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from .telegram_models import TelegramIntegration, TelegramPersonalJob
from .telegram_personal import authorize

logger = logging.getLogger(__name__)
INTERRUPTED = 'AI_INTERRUPTED'
RECOVERY_TEXT = 'Не выполнено, повтори.'
RECOVERY_NOTICE_BATCH = 20


def _insert(db: AsyncSession, model: Any):
    dialect = db.get_bind().dialect.name
    if dialect == 'postgresql':
        return pg_insert(model)
    if dialect == 'sqlite':
        return sqlite_insert(model)
    raise ValueError('Personal queue requires PostgreSQL or SQLite')


def _active():
    return (
        TelegramIntegration.enabled.is_(True), TelegramIntegration.deleted_at.is_(None),
        TelegramIntegration.encrypted_token.is_not(None), TelegramIntegration.owner_telegram_id.is_not(None),
    )


def _integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= 2**52


async def enqueue_owner_message(db: AsyncSession, item: TelegramIntegration,
                                payload: dict[str, Any], at: datetime) -> None:
    """Flush only: the caller commits job, receipt and polling cursor together.

    The quote is stored separately as untrusted data, never as an instruction.
    Verify identity here too, so direct callers cannot queue a foreign chat.
    """
    message = payload.get('message')
    if not isinstance(message, dict):
        return
    sender, chat = message.get('from'), message.get('chat')
    update_id, content = payload.get('update_id'), message.get('text')
    if (not isinstance(sender, dict) or not isinstance(chat, dict)
            or not _integer(sender.get('id')) or sender.get('is_bot')
            or chat.get('type') != 'private' or chat.get('id') != sender['id']
            or any(message.get(key) for key in ('forward_origin', 'forward_from', 'forward_from_chat', 'sender_business_bot'))
            or not isinstance(update_id, int) or isinstance(update_id, bool) or not 0 <= update_id <= 2**52
            or not isinstance(content, str) or not content.strip() or len(content) > 4096):
        return
    active = (await db.execute(select(TelegramIntegration).where(
        TelegramIntegration.id == item.id, TelegramIntegration.owner_id == item.owner_id,
        TelegramIntegration.owner_telegram_id == sender['id'], *_active(),
    ).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    if active is None:
        return
    authorize(active, 'ai.personal.write')
    existing = (await db.execute(select(TelegramPersonalJob.id).where(
        TelegramPersonalJob.integration_id == active.id, TelegramPersonalJob.telegram_update_id == update_id,
    ))).scalar_one_or_none()
    if existing is not None:
        return
    conversation = (await db.execute(select(AIConversation).where(
        AIConversation.id == active.personal_conversation_id, AIConversation.owner_id == active.owner_id,
        AIConversation.deleted_at.is_(None),
    ))).scalar_one_or_none() if active.personal_conversation_id else None
    if conversation is None:
        conversation = AIConversation(owner_id=active.owner_id, title='Telegram assistant')
        db.add(conversation)
        await db.flush()
        active.personal_conversation_id = conversation.id
        active.version += 1
        await db.flush()
    reply = message.get('reply_to_message')
    quote = reply.get('text') if isinstance(reply, dict) else None
    message_id = message.get('message_id')
    await db.execute(_insert(db, TelegramPersonalJob).values(
        owner_id=active.owner_id, integration_id=active.id, telegram_update_id=update_id,
        telegram_message_id=message_id if _integer(message_id) else None,
        text=content, quote=quote[:4096] if isinstance(quote, str) else None,
        conversation_id=conversation.id,
        state='queued', created_at=utc(at), recovery_notice_sent=False,
    ).on_conflict_do_nothing(index_elements=['integration_id', 'telegram_update_id']))
    await db.flush()


async def claim_personal_job(integration_id: str, at: datetime) -> str | None:
    """Durably claim one oldest job, with at most one running per integration."""
    async with database.SessionLocal() as db:
        item = (await db.execute(select(TelegramIntegration).where(
            TelegramIntegration.id == integration_id, *_active(),
        ))).scalar_one_or_none()
        if item is None:
            return None
        if db.get_bind().dialect.name == 'postgresql':
            await db.execute(text('SELECT pg_advisory_xact_lock(hashtext(:key))'), {'key': f'sync-owner:{item.owner_id}'})
        authorize(item, 'ai.personal.write')
        running = aliased(TelegramPersonalJob)
        no_running = ~exists(select(running.id).where(
            running.integration_id == integration_id, running.state == 'running',
            running.owner_id == item.owner_id, running.deleted_at.is_(None),
        ))
        active = exists(select(TelegramIntegration.id).where(
            TelegramIntegration.id == integration_id, TelegramIntegration.owner_id == item.owner_id, *_active(),
        ))
        oldest = select(TelegramPersonalJob.id).where(
            TelegramPersonalJob.integration_id == integration_id, TelegramPersonalJob.owner_id == item.owner_id,
            TelegramPersonalJob.state == 'queued', TelegramPersonalJob.deleted_at.is_(None),
        ).order_by(TelegramPersonalJob.created_at, TelegramPersonalJob.id).limit(1).scalar_subquery()
        result = await db.execute(update(TelegramPersonalJob).where(
            TelegramPersonalJob.id == oldest, TelegramPersonalJob.state == 'queued', no_running, active,
        ).values(state='running', started_at=utc(at), version=TelegramPersonalJob.version + 1)
            .returning(TelegramPersonalJob.id).execution_options(synchronize_session=False))
        job_id = result.scalar_one_or_none()
        await db.commit()
        return job_id


async def fail_interrupted_personal_jobs() -> None:
    """Startup-only recovery: fail running jobs without executing/requeuing them."""
    async with database.SessionLocal() as db:
        integrations = (await db.execute(select(TelegramIntegration).join(
            TelegramPersonalJob, (TelegramPersonalJob.integration_id == TelegramIntegration.id)
            & (TelegramPersonalJob.owner_id == TelegramIntegration.owner_id),
        ).where(TelegramPersonalJob.state == 'running', TelegramPersonalJob.deleted_at.is_(None)).distinct())).scalars()
        for item in integrations:
            authorize(item, 'ai.personal.write')
            finished_at = now()
            recovered = await db.execute(update(TelegramPersonalJob).where(
                TelegramPersonalJob.integration_id == item.id, TelegramPersonalJob.owner_id == item.owner_id,
                TelegramPersonalJob.state == 'running', TelegramPersonalJob.deleted_at.is_(None),
            ).values(state='failed', error_code=INTERRUPTED, finished_at=finished_at, version=TelegramPersonalJob.version + 1)
                .returning(TelegramPersonalJob.run_id, TelegramPersonalJob.conversation_id)
                .execution_options(synchronize_session=False))
            for run_id, conversation_id in recovered.all():
                if run_id is None or conversation_id is None:
                    continue
                authorize(item, 'ai.personal.write')
                await db.execute(update(AIRun).where(
                    AIRun.id == run_id, AIRun.owner_id == item.owner_id,
                    AIRun.conversation_id == conversation_id, AIRun.status == 'running', AIRun.deleted_at.is_(None),
                    exists(select(AIConversation.id).where(
                        AIConversation.id == conversation_id, AIConversation.owner_id == item.owner_id,
                    )),
                ).values(status='failed', completed_at=finished_at, version=AIRun.version + 1)
                    .execution_options(synchronize_session=False))
        await db.commit()


async def notify_interrupted_personal_jobs(integration_id: str) -> None:
    """Claim recovery notices before sending; keep only generic local fallbacks."""
    from . import telegram_service as service

    async with database.SessionLocal() as db:
        item = (await db.execute(select(TelegramIntegration).where(
            TelegramIntegration.id == integration_id, *_active(),
        ))).scalar_one_or_none()
        if item is None:
            return
        job_ids = list((await db.execute(select(TelegramPersonalJob.id).where(
            TelegramPersonalJob.integration_id == integration_id, TelegramPersonalJob.owner_id == item.owner_id,
            TelegramPersonalJob.state == 'failed', TelegramPersonalJob.error_code == INTERRUPTED,
            TelegramPersonalJob.recovery_notice_sent.is_(False), TelegramPersonalJob.deleted_at.is_(None),
        ).order_by(TelegramPersonalJob.created_at, TelegramPersonalJob.id).limit(RECOVERY_NOTICE_BATCH))).scalars())
        for job_id in job_ids:
            await db.refresh(item)
            if not item.enabled or item.deleted_at or not item.encrypted_token or not item.owner_telegram_id:
                return
            try:
                authorize(item, 'ai.personal.write')
                authorize(item, 'notifications.write')
            except PolicyDenied:
                return
            claimed = await db.execute(update(TelegramPersonalJob).where(
                TelegramPersonalJob.id == job_id, TelegramPersonalJob.integration_id == integration_id,
                TelegramPersonalJob.owner_id == item.owner_id, TelegramPersonalJob.state == 'failed',
                TelegramPersonalJob.error_code == INTERRUPTED, TelegramPersonalJob.recovery_notice_sent.is_(False),
                TelegramPersonalJob.deleted_at.is_(None),
            ).values(recovery_notice_sent=True, version=TelegramPersonalJob.version + 1)
                .returning(TelegramPersonalJob.id).execution_options(synchronize_session=False))
            if claimed.scalar_one_or_none() is None:
                await db.rollback()
                continue
            await db.execute(_insert(db, Notification).values(
                owner_id=item.owner_id, kind='telegram.personal.interrupted', title='Assistant request interrupted',
                body=None, data_json={'job_id': job_id}, dedup_key=f'telegram-personal-interrupted:{job_id}',
            ).on_conflict_do_nothing(index_elements=['dedup_key']))
            token, chat_id = item.encrypted_token, item.owner_telegram_id
            # Crash/timeout after this commit may lose the DM; it must not retry.
            await db.commit()
            await db.refresh(item)
            if (not item.enabled or item.deleted_at or item.encrypted_token != token
                    or item.owner_telegram_id != chat_id):
                continue
            try:
                authorize(item, 'telegram.notify_owner', external=True)
                async with service.TelegramClient(decrypt_secret(token)) as client:
                    await client.send_message(chat_id, RECOVERY_TEXT)
            except Exception:  # noqa: BLE001 - generic durable fallback; never log credentials/content
                logger.info('Telegram personal recovery notice unavailable')
