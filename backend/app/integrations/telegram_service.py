"""Owner-bound Telegram Business ingestion, durable claims and policy checked replies."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from app.ai.crypto import decrypt_secret
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.ai.tools import ToolDescriptor
from app.core import db as database
from app.core.models import now
from app.core.security import token_hash
from fastapi import HTTPException
from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .telegram_models import (
    TelegramBusinessConnection,
    TelegramBusinessMessage,
    TelegramIntegration,
    TelegramUpdateReceipt,
)
from .telegram_transport import TelegramClient, TelegramError


def error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and abs(value) <= 2**52


def mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def remote_code(exc: TelegramError) -> str:
    return {401: "TELEGRAM_TOKEN_INVALID", 403: "TELEGRAM_FORBIDDEN", 409: "TELEGRAM_POLL_CONFLICT", 429: "TELEGRAM_RATE_LIMITED", "timeout": "TELEGRAM_TIMEOUT"}.get(exc.code, "TELEGRAM_UNAVAILABLE")


async def get_integration(db: AsyncSession, owner_id: str, *, configured: bool = True) -> TelegramIntegration:
    item = (await db.execute(select(TelegramIntegration).where(TelegramIntegration.owner_id == owner_id))).scalar_one_or_none()
    if item is None or (configured and not item.encrypted_token):
        raise error(409, "TELEGRAM_NOT_CONFIGURED", "Подключите Telegram-бота в настройках.")
    return item


async def status(db: AsyncSession, owner_id: str) -> dict[str, Any]:
    item = (await db.execute(select(TelegramIntegration).where(TelegramIntegration.owner_id == owner_id))).scalar_one_or_none()
    if item is None:
        return {
            "configured": False, "id": None, "version": None, "bot_username": None,
            "bot_name": None, "business_capable": False, "enabled": False,
            "auto_reply": False, "owner_telegram_id": None, "provider_id": None,
            "model": None, "instructions": "", "last_polled_at": None,
            "last_error_code": None, "connections": [],
        }
    connections = list((await db.execute(select(TelegramBusinessConnection).where(TelegramBusinessConnection.integration_id == item.id, TelegramBusinessConnection.owner_id == owner_id))).scalars())
    return {
        "configured": bool(item.encrypted_token), "id": item.id, "version": item.version,
        "bot_username": item.bot_username if item.encrypted_token else None,
        "bot_name": item.bot_name if item.encrypted_token else None,
        "business_capable": item.business_capable, "enabled": item.enabled,
        "auto_reply": item.auto_reply, "owner_telegram_id": item.owner_telegram_id,
        "provider_id": item.provider_id, "model": item.model, "instructions": item.instructions,
        "last_polled_at": item.last_polled_at, "last_error_code": item.last_error_code,
        "connections": [{
            "id": connection.id, "enabled": connection.enabled,
            "telegram_user_id": connection.telegram_user_id,
            "can_reply": connection.rights.get("can_reply") is True,
        } for connection in connections],
    }


async def clear_messages(db: AsyncSession, integration_id: str, connection_id: str | None = None) -> None:
    filters = [TelegramBusinessMessage.integration_id == integration_id]
    if connection_id is not None:
        filters.append(TelegramBusinessMessage.business_connection_id == connection_id)
    await db.execute(update(TelegramBusinessMessage).where(*filters).values(text="", chat_title="", draft_text=None, draft_status="none", draft_error_code=None, deleted_at=now(), version=TelegramBusinessMessage.version + 1))


async def purge_integration(db: AsyncSession, item: TelegramIntegration) -> None:
    await db.execute(delete(TelegramBusinessMessage).where(TelegramBusinessMessage.integration_id == item.id))
    await db.execute(delete(TelegramBusinessConnection).where(TelegramBusinessConnection.integration_id == item.id))
    await db.execute(delete(TelegramUpdateReceipt).where(TelegramUpdateReceipt.integration_id == item.id))


async def accept_connection(db: AsyncSession, item: TelegramIntegration, raw: dict[str, Any]) -> TelegramBusinessConnection | None:
    user = mapping(raw.get("user"))
    connection_id = raw.get("id")
    if not isinstance(connection_id, str) or not 1 <= len(connection_id) <= 256 or not item.owner_telegram_id or user.get("id") != item.owner_telegram_id or not integer(raw.get("user_chat_id")):
        return None
    connection = await db.get(TelegramBusinessConnection, connection_id)
    if connection and (connection.integration_id != item.id or connection.owner_id != item.owner_id):
        return None
    enabled = raw.get("is_enabled") is True
    raw_rights = raw.get("rights")
    rights = raw_rights if isinstance(raw_rights, dict) else {}
    # Keep only the two rights this integration understands; no gift, stars,
    # profile, deletion or administrative permissions are inherited.
    rights = {name: rights.get(name) is True for name in ("can_reply", "can_read_messages")}
    if connection is None:
        connection = TelegramBusinessConnection(id=connection_id, integration_id=item.id, owner_id=item.owner_id, telegram_user_id=item.owner_telegram_id, user_chat_id=raw["user_chat_id"], enabled=enabled, rights=rights, connected_at=now(), updated_at=now())
        db.add(connection)
    else:
        connection.enabled = enabled; connection.rights = rights; connection.updated_at = now()
    if not enabled:
        await clear_messages(db, item.id, connection_id)
    await db.flush()
    return connection


async def verified_connection(db: AsyncSession, item: TelegramIntegration, client: TelegramClient, connection_id: str, *, fresh: bool = False) -> TelegramBusinessConnection | None:
    connection = await db.get(TelegramBusinessConnection, connection_id)
    if connection and (connection.integration_id != item.id or connection.owner_id != item.owner_id):
        return None
    if fresh or connection is None:
        raw = await client.get_business_connection(connection_id)
        if raw.get("id") != connection_id:
            return None
        connection = await accept_connection(db, item, raw)
    return connection if connection and connection.enabled and connection.telegram_user_id == item.owner_telegram_id else None


async def ingest_update(db: AsyncSession, item: TelegramIntegration, payload: dict[str, Any], client: TelegramClient) -> None:
    """No raw update/body is persisted. Receipt + cursor commit with domain data."""
    connection_raw = payload.get("business_connection")
    if isinstance(connection_raw, dict):
        await accept_connection(db, item, connection_raw)
        return
    ordinary = payload.get("message")
    if isinstance(ordinary, dict):
        text = ordinary.get("text", "")
        sender = mapping(ordinary.get("from")); chat = mapping(ordinary.get("chat"))
        if isinstance(text, str) and text.startswith("/start aelys_") and chat.get("type") == "private" and integer(sender.get("id")) and chat.get("id") == sender["id"] and not sender.get("is_bot"):
            code = text[len("/start aelys_"):].strip()
            if 20 <= len(code) <= 64:
                await db.execute(update(TelegramIntegration).where(TelegramIntegration.id == item.id, TelegramIntegration.enabled.is_(True), TelegramIntegration.binding_code_hash == token_hash(code), TelegramIntegration.binding_expires_at > now(), or_(TelegramIntegration.owner_telegram_id.is_(None), TelegramIntegration.owner_telegram_id == sender["id"])).values(owner_telegram_id=sender["id"], binding_code_hash=None, binding_expires_at=None, version=TelegramIntegration.version + 1).execution_options(synchronize_session=False))
                await db.refresh(item)
        return
    raw = payload.get("business_message") or payload.get("edited_business_message") or payload.get("deleted_business_messages")
    if not isinstance(raw, dict):
        return
    connection_id = raw.get("business_connection_id")
    if not isinstance(connection_id, str) or len(connection_id) > 256 or not item.owner_telegram_id:
        return
    connection = await verified_connection(db, item, client, connection_id)
    if connection is None:
        return
    chat = mapping(raw.get("chat"))
    if chat.get("type") != "private" or not integer(chat.get("id")):
        return
    if payload.get("deleted_business_messages"):
        ids = raw.get("message_ids")
        if isinstance(ids, list):
            await db.execute(update(TelegramBusinessMessage).where(TelegramBusinessMessage.integration_id == item.id, TelegramBusinessMessage.business_connection_id == connection_id, TelegramBusinessMessage.chat_id == chat["id"], TelegramBusinessMessage.telegram_message_id.in_([value for value in ids[:1000] if integer(value)])).values(text="", chat_title="", draft_text=None, deleted_at=now(), draft_status="none", version=TelegramBusinessMessage.version + 1))
        return
    sender = mapping(raw.get("from"))
    if not integer(raw.get("message_id")) or not integer(raw.get("date")) or not integer(sender.get("id")):
        return
    # Ignore bot-generated messages, forwarded payloads, unsupported media and
    # old imported messages. The connector responds only to plain private text.
    text = raw.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 4096 or sender.get("is_bot") or raw.get("sender_business_bot") or raw.get("forward_origin") or raw.get("forward_from"):
        return
    direction = "owner" if sender["id"] == item.owner_telegram_id else "inbound"
    if direction == "inbound" and sender["id"] != chat["id"]:
        return
    try:
        sent_at = datetime.fromtimestamp(raw["date"], UTC)
    except (ValueError, OSError, OverflowError):
        return
    if sent_at > now() + timedelta(minutes=5) or sent_at < now() - timedelta(days=7):
        return
    stored = (await db.execute(select(TelegramBusinessMessage).where(TelegramBusinessMessage.integration_id == item.id, TelegramBusinessMessage.business_connection_id == connection_id, TelegramBusinessMessage.chat_id == chat["id"], TelegramBusinessMessage.telegram_message_id == raw["message_id"]))).scalar_one_or_none()
    if stored:
        if stored.deleted_at or stored.text == text:
            return
        stored.text = text; stored.edited_at = now(); stored.version += 1
        if stored.draft_status not in {"sent", "sending", "unknown"}:
            stored.draft_text = None; stored.draft_status = "none"; stored.draft_error_code = None
    else:
        db.add(TelegramBusinessMessage(owner_id=item.owner_id, integration_id=item.id, business_connection_id=connection_id, chat_id=chat["id"], telegram_message_id=raw["message_id"], sender_id=sender["id"], chat_title=str(chat.get("first_name") or chat.get("title") or chat.get("username") or chat["id"])[:200], text=text, sent_at=sent_at, direction=direction))
    await db.flush()


async def poll_once(integration_id: str, *, timeout: int = 20) -> int:
    lease = uuid4().hex
    async with database.SessionLocal() as db:
        claim = await db.execute(update(TelegramIntegration).where(TelegramIntegration.id == integration_id, TelegramIntegration.enabled.is_(True), TelegramIntegration.encrypted_token.is_not(None), or_(TelegramIntegration.lease_expires_at.is_(None), TelegramIntegration.lease_expires_at < now())).values(lease_owner=lease, lease_expires_at=now() + timedelta(seconds=120)))
        await db.commit()
        if int(getattr(claim, "rowcount", 0) or 0) != 1:
            return 0
        item = await db.get(TelegramIntegration, integration_id)
        if not item or not item.encrypted_token:
            return 0
        original_token = item.encrypted_token
        offset = item.last_update_id + 1
        retry_after = None
        try:
            async with TelegramClient(decrypt_secret(original_token)) as client:
                # An operator-owned webhook is never removed as a shortcut.
                hook = await client.get_webhook_info()
                if hook.get("url"):
                    raise TelegramError("webhook_conflict")
                identity = await client.get_me()
                if identity.get("id") != item.bot_id:
                    raise TelegramError("identity_mismatch")
                item.business_capable = identity.get("can_connect_to_business") is True
                await db.commit()
                updates = await client.get_updates(offset, timeout)
                processed = 0
                for payload in sorted(updates, key=lambda raw: raw["update_id"] if integer(raw.get("update_id")) else -1):
                    update_id = payload.get("update_id", -1)
                    if not integer(update_id) or update_id < 0:
                        continue
                    await db.refresh(item)
                    if item.lease_owner != lease or not item.enabled or item.encrypted_token != original_token:
                        break
                    if update_id <= item.last_update_id:
                        continue
                    if await db.get(TelegramUpdateReceipt, (item.id, update_id)) is None:
                        await ingest_update(db, item, payload, client)
                        db.add(TelegramUpdateReceipt(integration_id=item.id, update_id=update_id))
                    cursor_claim = await db.execute(update(TelegramIntegration).where(TelegramIntegration.id == integration_id, TelegramIntegration.lease_owner == lease, TelegramIntegration.encrypted_token == original_token, TelegramIntegration.enabled.is_(True)).values(last_update_id=update_id, last_polled_at=now(), last_error_code=None, lease_expires_at=now() + timedelta(seconds=120)))
                    if int(getattr(cursor_claim, "rowcount", 0) or 0) != 1:
                        await db.rollback()
                        break
                    await db.commit(); processed += 1
                await db.execute(update(TelegramIntegration).where(TelegramIntegration.id == integration_id, TelegramIntegration.lease_owner == lease).values(last_polled_at=now(), last_error_code=None))
                await db.commit()
                return processed
        except TelegramError as exc:
            await db.rollback()
            if exc.code == 429 and exc.retry_after is not None:
                retry_after = now() + timedelta(seconds=min(max(exc.retry_after, 1), 86400))
            code = "TELEGRAM_WEBHOOK_CONFLICT" if exc.code == "webhook_conflict" else remote_code(exc)
            await db.execute(update(TelegramIntegration).where(TelegramIntegration.id == integration_id, TelegramIntegration.lease_owner == lease).values(last_error_code=code))
            await db.commit()
            raise error(409 if code in {"TELEGRAM_WEBHOOK_CONFLICT", "TELEGRAM_POLL_CONFLICT"} else 503, code, "Не удалось получить обновления Telegram.") from None
        except BaseException:
            # Do not let the lease-release commit flush partial domain writes.
            await db.rollback()
            raise
        finally:
            await db.execute(update(TelegramIntegration).where(TelegramIntegration.id == integration_id, TelegramIntegration.lease_owner == lease).values(lease_owner=None, lease_expires_at=retry_after))
            await db.commit()


async def generate_draft(db: AsyncSession, item: TelegramIntegration, message: TelegramBusinessMessage, version: int) -> TelegramBusinessMessage:
    from .telegram_ai import TelegramAIError, generate_business_draft
    if not item.enabled or not item.encrypted_token or message.deleted_at or message.direction != "inbound":
        raise error(409, "TELEGRAM_MESSAGE_UNAVAILABLE", "Сообщение недоступно для ответа.")
    async with TelegramClient(decrypt_secret(item.encrypted_token)) as client:
        connection = await verified_connection(db, item, client, message.business_connection_id, fresh=True)
    await db.commit()
    if not connection or not connection.rights.get("can_reply"):
        raise error(403, "TELEGRAM_REPLY_DENIED", "Подключение Telegram или право отвечать отозвано.")
    await db.refresh(item)
    if not item.enabled or not item.encrypted_token:
        raise error(409, "TELEGRAM_PAUSED", "Telegram-ассистент приостановлен.")
    claim = await db.execute(update(TelegramBusinessMessage).where(TelegramBusinessMessage.id == message.id, TelegramBusinessMessage.version == version, TelegramBusinessMessage.draft_status.in_(["none", "ready", "failed"]), TelegramBusinessMessage.deleted_at.is_(None)).values(draft_status="generating", draft_error_code=None, updated_at=now(), version=TelegramBusinessMessage.version + 1))
    await db.commit()
    if int(getattr(claim, "rowcount", 0) or 0) != 1:
        raise error(409, "VERSION_CONFLICT", "Сообщение уже изменено. Обновите список.")
    await db.refresh(message)
    claimed_version = message.version
    try:
        draft = await generate_business_draft(db, item, message)
        await db.refresh(item)
        if not item.enabled or not item.encrypted_token:
            raise TelegramAIError("TELEGRAM_PAUSED")
        changed = await db.execute(update(TelegramBusinessMessage).where(TelegramBusinessMessage.id == message.id, TelegramBusinessMessage.version == claimed_version, TelegramBusinessMessage.draft_status == "generating", TelegramBusinessMessage.deleted_at.is_(None)).values(draft_text=draft, draft_status="ready", draft_error_code=None, updated_at=now(), version=TelegramBusinessMessage.version + 1))
        await db.commit()
        if int(getattr(changed, "rowcount", 0) or 0) != 1:
            raise error(409, "VERSION_CONFLICT", "Сообщение изменилось во время подготовки ответа.")
    except TelegramAIError as exc:
        await db.execute(update(TelegramBusinessMessage).where(TelegramBusinessMessage.id == message.id, TelegramBusinessMessage.version == claimed_version).values(draft_status="failed", draft_error_code=exc.code, version=TelegramBusinessMessage.version + 1))
        await db.commit()
        raise error(409, exc.code, "Не удалось подготовить AI-ответ. Проверьте провайдера и лимит.") from None
    await db.refresh(message)
    return message


async def send_reply(db: AsyncSession, item: TelegramIntegration, message: TelegramBusinessMessage, version: int, text: str, *, automatic: bool = False) -> TelegramBusinessMessage:
    if not item.enabled or not item.encrypted_token or not item.owner_telegram_id or message.deleted_at or message.direction != "inbound":
        raise error(409, "TELEGRAM_MESSAGE_UNAVAILABLE", "Сообщение недоступно для ответа.")
    if automatic and not item.auto_reply:
        raise error(403, "POLICY_DENIED", "Автоответы отключены.")
    if message.draft_status == "sent":
        if message.draft_text == text:
            return message
        raise error(409, "ALREADY_SENT", "На это сообщение уже отправлен ответ.")
    if message.version != version or message.draft_status in {"generating", "sending", "unknown"}:
        raise error(409, "VERSION_CONFLICT", "Обновите состояние сообщения перед отправкой.")
    if not text.strip() or len(text) > 4096:
        raise error(422, "VALIDATION_ERROR", "Ответ должен содержать от 1 до 4096 символов.")
    if item.last_error_code == "TELEGRAM_RATE_LIMITED" and item.lease_expires_at and utc(item.lease_expires_at) > now():
        raise error(429, "TELEGRAM_RATE_LIMITED", "Telegram просит подождать перед повторной отправкой.")
    send_token = item.encrypted_token
    async with TelegramClient(decrypt_secret(send_token)) as client:
        connection = await verified_connection(db, item, client, message.business_connection_id, fresh=True)
        await db.commit()
        if not connection or not connection.rights.get("can_reply"):
            raise error(403, "TELEGRAM_REPLY_DENIED", "Telegram отозвал право отвечать в этом чате.")
        recent = (await db.execute(select(TelegramBusinessMessage.sent_at).where(TelegramBusinessMessage.integration_id == item.id, TelegramBusinessMessage.business_connection_id == connection.id, TelegramBusinessMessage.chat_id == message.chat_id, TelegramBusinessMessage.direction == "inbound", TelegramBusinessMessage.deleted_at.is_(None)).order_by(TelegramBusinessMessage.sent_at.desc()).limit(1))).scalar_one_or_none()
        if recent is None or utc(recent) < now() - timedelta(hours=24):
            raise error(403, "TELEGRAM_REPLY_WINDOW_EXPIRED", "Окно ответа Telegram (24 часа) истекло.")
        # Human owner activity since this inbound message suppresses automatic replies.
        if automatic:
            human = (await db.execute(select(TelegramBusinessMessage.id).where(TelegramBusinessMessage.integration_id == item.id, TelegramBusinessMessage.business_connection_id == connection.id, TelegramBusinessMessage.chat_id == message.chat_id, TelegramBusinessMessage.direction == "owner", TelegramBusinessMessage.sent_at >= message.sent_at).limit(1))).first()
            if human:
                raise error(409, "OWNER_ALREADY_REPLIED", "Владелец уже ответил в этом чате.")
            sent_recently = list((await db.execute(select(TelegramBusinessMessage.chat_id).where(TelegramBusinessMessage.integration_id == item.id, TelegramBusinessMessage.draft_status == "sent", TelegramBusinessMessage.updated_at >= now() - timedelta(minutes=1)))).scalars())
            if len(sent_recently) >= 20 or sent_recently.count(message.chat_id) >= 6:
                raise error(429, "TELEGRAM_RATE_LIMITED", "Лимит автоматических ответов достигнут.")
            newer = (await db.execute(select(TelegramBusinessMessage.id).where(TelegramBusinessMessage.integration_id == item.id, TelegramBusinessMessage.business_connection_id == connection.id, TelegramBusinessMessage.chat_id == message.chat_id, TelegramBusinessMessage.direction == "inbound", TelegramBusinessMessage.sent_at > message.sent_at, TelegramBusinessMessage.deleted_at.is_(None)).limit(1))).first()
            if newer:
                raise error(409, "NEWER_MESSAGE_EXISTS", "Есть более новое входящее сообщение.")
        descriptor = ToolDescriptor("telegram.reply", "Reply to the verified customer chat", "telegram.reply", lambda arguments: arguments, lambda arguments: asyncio.sleep(0, result={}), external_effect=True)
        ServerPolicyEngine().authorize(descriptor, ToolCall("telegram.reply", {"chat_id": message.chat_id}), PermissionContext(actor=f"telegram:{item.id}", scopes=frozenset({"telegram.reply"}), allow_external_effects=not automatic or item.auto_reply, policy_id="telegram-business"))
        # Atomic pre-send claim. Ambiguous transport results stay unknown and
        # never auto-retry; Telegram sendMessage has no idempotency parameter.
        claimed = await db.execute(update(TelegramBusinessMessage).where(TelegramBusinessMessage.id == message.id, TelegramBusinessMessage.version == version, TelegramBusinessMessage.deleted_at.is_(None), TelegramBusinessMessage.draft_status.in_(["none", "ready", "failed"])).values(draft_status="sending", draft_text=text, draft_error_code=None, updated_at=now(), version=TelegramBusinessMessage.version + 1))
        await db.commit()
        if int(getattr(claimed, "rowcount", 0) or 0) != 1:
            raise error(409, "VERSION_CONFLICT", "Ответ уже отправляется или сообщение изменено.")
        await db.refresh(message); claimed_version = message.version
        await db.refresh(item)
        if not item.enabled or item.encrypted_token != send_token or (automatic and not item.auto_reply):
            message.draft_status = "failed"; message.draft_error_code = "TELEGRAM_PAUSED"; message.version += 1
            await db.commit()
            raise error(409, "TELEGRAM_PAUSED", "Telegram-ассистент приостановлен.")
        try:
            sent = await client.send_message(message.chat_id, text, business_connection_id=connection.id, reply_to_message_id=message.telegram_message_id)
        except TelegramError as exc:
            ambiguous = exc.code in {"timeout", "network_error", "invalid_response"} or (isinstance(exc.code, int) and exc.code >= 500)
            if exc.code == 429:
                # Share the bot-wide cooldown with polling and manual sends.
                item.last_error_code = "TELEGRAM_RATE_LIMITED"
                item.lease_expires_at = now() + timedelta(seconds=min(max(exc.retry_after or 30, 1), 86400))
            await db.execute(update(TelegramBusinessMessage).where(TelegramBusinessMessage.id == message.id, TelegramBusinessMessage.version == claimed_version).values(draft_status="unknown" if ambiguous else "failed", draft_error_code=remote_code(exc), version=TelegramBusinessMessage.version + 1))
            await db.commit()
            raise error(503, "TELEGRAM_DELIVERY_UNKNOWN" if ambiguous else remote_code(exc), "Проверьте переписку Telegram перед повторной отправкой.") from None
        if not integer(sent.get("message_id")):
            message.draft_status = "unknown"; message.draft_error_code = "TELEGRAM_DELIVERY_UNKNOWN"; message.version += 1
            await db.commit()
            raise error(503, "TELEGRAM_DELIVERY_UNKNOWN", "Проверьте переписку Telegram.")
        await db.execute(update(TelegramBusinessMessage).where(TelegramBusinessMessage.id == message.id, TelegramBusinessMessage.version == claimed_version).values(draft_status="sent", reply_message_id=sent["message_id"], draft_error_code=None, version=TelegramBusinessMessage.version + 1))
        # Reuse the inbound record as reply history without persisting an entire
        # raw Telegram response. The draft contains the actual sent text.
        await db.commit(); await db.refresh(message)
        return message


async def auto_reply_once(integration_id: str) -> None:
    async with database.SessionLocal() as db:
        item = await db.get(TelegramIntegration, integration_id)
        if not item or not item.enabled or not item.auto_reply or not item.encrypted_token or not item.owner_telegram_id:
            return
        # Recent inbound messages only: enabling auto-reply never bulk replies
        # to old history, and catch-up after a long outage remains manual.
        messages = list((await db.execute(select(TelegramBusinessMessage).where(TelegramBusinessMessage.integration_id == item.id, TelegramBusinessMessage.direction == "inbound", TelegramBusinessMessage.deleted_at.is_(None), TelegramBusinessMessage.sent_at >= now() - timedelta(minutes=5), TelegramBusinessMessage.draft_status == "none").order_by(TelegramBusinessMessage.sent_at).limit(10))).scalars())
        for message in messages:
            try:
                await db.refresh(item)
                if not item.enabled or not item.auto_reply:
                    return
                prepared = await generate_draft(db, item, message, message.version)
                await send_reply(db, item, prepared, prepared.version, prepared.draft_text or "", automatic=True)
            except (HTTPException, TelegramError):
                await db.rollback()
                continue


async def poll_integration_safely(integration_id: str) -> bool:
    """Keep one integration failure isolated from the supervised connector."""
    try:
        await poll_once(integration_id)
        await auto_reply_once(integration_id)
    except Exception:  # noqa: BLE001 - isolate one integration from the supervisor
        # No customer text, token, request URL or provider exception is emitted.
        return False
    return True


async def connector_iteration() -> None:
    async with database.SessionLocal() as db:
        ids = list((await db.execute(select(TelegramIntegration.id).where(TelegramIntegration.enabled.is_(True), TelegramIntegration.encrypted_token.is_not(None)))).scalars())
        # Failed workers never blindly re-send ambiguous deliveries.
        await db.execute(update(TelegramBusinessMessage).where(TelegramBusinessMessage.draft_status == "sending", TelegramBusinessMessage.updated_at < now() - timedelta(minutes=3)).values(draft_status="unknown", draft_error_code="TELEGRAM_DELIVERY_UNKNOWN", version=TelegramBusinessMessage.version + 1))
        await db.execute(update(TelegramBusinessMessage).where(TelegramBusinessMessage.draft_status == "generating", TelegramBusinessMessage.updated_at < now() - timedelta(minutes=3)).values(draft_status="failed", draft_error_code="AI_INTERRUPTED", version=TelegramBusinessMessage.version + 1))
        # Minimal retention: expired business message contents are erased.
        await db.execute(update(TelegramBusinessMessage).where(TelegramBusinessMessage.deleted_at.is_(None), TelegramBusinessMessage.sent_at < now() - timedelta(days=7)).values(text="", draft_text=None, chat_title="", deleted_at=now(), version=TelegramBusinessMessage.version + 1))
        await db.commit()
    for integration_id in ids:
        await poll_integration_safely(integration_id)


async def connector_loop() -> None:
    """Background connector works on loopback with no publicly exposed webhook."""
    # Import inside loop so no credentials/DB are touched merely by importing app.
    while True:
        try:
            await connector_iteration()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - keep startup available during migrations
            # Database may be migrating at process startup. Keep the service
            # available and try again after a bounded delay.
            await asyncio.sleep(0)
        await asyncio.sleep(3)
