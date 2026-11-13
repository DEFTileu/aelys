"""Explicit owner sends to an existing Business chat, independent of AI replies."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Any, Literal

from app.ai.crypto import decrypt_secret
from app.ai.errors import PolicyDenied
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.ai.tools import ToolDescriptor
from app.core.config import get_settings
from app.core.models import now
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from . import telegram_service as service
from .telegram_models import (
    TelegramBusinessConnection,
    TelegramBusinessMessage,
    TelegramChatSend,
    TelegramIntegration,
)
from .telegram_transport import TelegramError


def authorize(item: TelegramIntegration, *, editing: bool = False) -> None:
    name = "telegram.chat.edit" if editing else "telegram.chat.send"
    descriptor = ToolDescriptor(
        name,
        "Edit an owner command in a verified chat" if editing else "Send an owner message to a verified chat",
        "telegram.reply",
        lambda arguments: arguments,
        lambda arguments: asyncio.sleep(0, result={}),
        external_effect=True,
    )
    try:
        ServerPolicyEngine().authorize(
            descriptor,
            ToolCall(name, {}),
            PermissionContext(
                actor=f"owner:{item.owner_id}",
                scopes=frozenset({"telegram.reply"}),
                allow_external_effects=True,
                policy_id="telegram-business",
            ),
        )
    except PolicyDenied:
        raise service.error(
            403, "POLICY_DENIED", "Отправка запрещена политикой."
        ) from None


def availability(
    item: TelegramIntegration, connection: TelegramBusinessConnection | None, latest
) -> dict[str, Any]:
    expires = service.utc(latest) + timedelta(hours=24) if latest else None
    code = None
    if not item.encrypted_token:
        code = "TELEGRAM_NOT_CONFIGURED"
    elif not item.enabled:
        code = "TELEGRAM_PAUSED"
    elif not item.owner_telegram_id:
        code = "TELEGRAM_BINDING_REQUIRED"
    elif (
        not connection
        or not connection.enabled
        or connection.owner_id != item.owner_id
        or connection.integration_id != item.id
        or connection.telegram_user_id != item.owner_telegram_id
        or connection.rights.get("can_reply") is not True
    ):
        code = "TELEGRAM_REPLY_DENIED"
    elif expires is None or expires <= now():
        code = "TELEGRAM_REPLY_WINDOW_EXPIRED"
    elif (
        item.last_error_code == "TELEGRAM_RATE_LIMITED"
        and item.lease_expires_at
        and service.utc(item.lease_expires_at) > now()
    ):
        code = "TELEGRAM_RATE_LIMITED"
    return {
        "can_send": code is None,
        "send_disabled_code": code,
        "reply_window_expires_at": expires,
    }


async def chats(db: AsyncSession, item: TelegramIntegration) -> list[dict[str, Any]]:
    pairs = (
        await db.execute(
            select(
                TelegramBusinessMessage.business_connection_id,
                TelegramBusinessMessage.chat_id,
                func.max(TelegramBusinessMessage.sent_at).label("latest"),
            )
            .where(
                TelegramBusinessMessage.owner_id == item.owner_id,
                TelegramBusinessMessage.integration_id == item.id,
                TelegramBusinessMessage.deleted_at.is_(None),
            )
            .group_by(
                TelegramBusinessMessage.business_connection_id,
                TelegramBusinessMessage.chat_id,
            )
            .order_by(func.max(TelegramBusinessMessage.sent_at).desc())
            .limit(100)
        )
    ).all()
    connections = {
        c.id: c
        for c in (
            await db.execute(
                select(TelegramBusinessConnection).where(
                    TelegramBusinessConnection.owner_id == item.owner_id,
                    TelegramBusinessConnection.integration_id == item.id,
                )
            )
        ).scalars()
    }
    incoming = {
        (row.business_connection_id, row.chat_id): row.latest
        for row in (
            await db.execute(
                select(
                    TelegramBusinessMessage.business_connection_id,
                    TelegramBusinessMessage.chat_id,
                    func.max(TelegramBusinessMessage.sent_at).label("latest"),
                )
                .where(
                    TelegramBusinessMessage.owner_id == item.owner_id,
                    TelegramBusinessMessage.integration_id == item.id,
                    TelegramBusinessMessage.direction == "inbound",
                    TelegramBusinessMessage.deleted_at.is_(None),
                )
                .group_by(
                    TelegramBusinessMessage.business_connection_id,
                    TelegramBusinessMessage.chat_id,
                )
            )
        ).all()
    }
    return [
        {
            "business_connection_id": connection_id,
            "chat_id": chat_id,
            **availability(
                item,
                connections.get(connection_id),
                incoming.get((connection_id, chat_id)),
            ),
        }
        for connection_id, chat_id, _ in pairs
    ]


def fingerprint(connection_id: str, chat_id: int, body: str, reply_to_message_id: int | None = None) -> str:
    # HMAC prevents a content-free receipt becoming an offline dictionary of short messages.
    payload = json.dumps(
        [connection_id, chat_id, body] + ([reply_to_message_id] if reply_to_message_id is not None else []), ensure_ascii=False, separators=(",", ":")
    )
    return hmac.new(
        get_settings().secret_key.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()


async def replay(
    db: AsyncSession, receipt: TelegramChatSend, digest: str
) -> TelegramBusinessMessage:
    if not hmac.compare_digest(receipt.request_hash, digest):
        raise service.error(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Этот ключ уже использован для другого сообщения.",
        )
    if receipt.send_status == "sent":
        stored = (
            await db.get(TelegramBusinessMessage, receipt.message_id)
            if receipt.message_id
            else None
        )
        if stored is not None:
            return stored
    if receipt.send_status == "sending":
        raise service.error(
            409,
            "TELEGRAM_SEND_IN_PROGRESS",
            "Отправка уже начата. Не повторяйте сообщение, проверьте чат Telegram.",
        )
    raise service.error(
        503,
        receipt.error_code or "TELEGRAM_DELIVERY_UNKNOWN",
        "Проверьте переписку Telegram. Эта отправка не повторяется автоматически.",
    )


async def _latest(
    db: AsyncSession, item: TelegramIntegration, connection_id: str, chat_id: int
) -> TelegramBusinessMessage | None:
    return (
        await db.execute(
            select(TelegramBusinessMessage)
            .where(
                TelegramBusinessMessage.owner_id == item.owner_id,
                TelegramBusinessMessage.integration_id == item.id,
                TelegramBusinessMessage.business_connection_id == connection_id,
                TelegramBusinessMessage.chat_id == chat_id,
                TelegramBusinessMessage.direction == "inbound",
                TelegramBusinessMessage.deleted_at.is_(None),
            )
            .order_by(TelegramBusinessMessage.sent_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def send_chat(
    db: AsyncSession,
    item: TelegramIntegration,
    connection_id: str,
    chat_id: int,
    body: str,
    key: str,
    reply_to_message_id: int | None = None,
    *, before_send: Callable[[], Awaitable[None]] | None = None,
    direction: Literal["owner", "outbound"] = "owner",
    edit_message_id: int | None = None,
    edit_source_version: int | None = None,
) -> TelegramBusinessMessage:
    editing = edit_message_id is not None
    authorize(item, editing=editing)
    digest = fingerprint(connection_id, chat_id, body, reply_to_message_id)
    if editing:
        digest = fingerprint(connection_id, chat_id, "edit:" + digest, edit_message_id)
    old = (
        await db.execute(
            select(TelegramChatSend).where(
                TelegramChatSend.owner_id == item.owner_id,
                TelegramChatSend.idempotency_key == key,
            )
        )
    ).scalar_one_or_none()
    if old:
        return await replay(db, old, digest)
    async def edit_target() -> TelegramBusinessMessage:
        target = (await db.execute(select(TelegramBusinessMessage).where(
            TelegramBusinessMessage.owner_id == item.owner_id,
            TelegramBusinessMessage.integration_id == item.id,
            TelegramBusinessMessage.business_connection_id == connection_id,
            TelegramBusinessMessage.chat_id == chat_id,
            TelegramBusinessMessage.telegram_message_id == edit_message_id,
        ).execution_options(populate_existing=True))).scalar_one_or_none()
        if (not target or target.deleted_at or target.direction != "owner"
                or target.sender_id != item.owner_telegram_id or target.media_metadata
                or edit_source_version is None or target.version != edit_source_version
                or service.utc(target.sent_at) + timedelta(hours=48) <= now()):
            raise service.error(409, "COMMAND_STALE", "Command cannot be edited")
        return target

    if editing:
        await edit_target()
    connection = await db.get(TelegramBusinessConnection, connection_id)
    incoming = await _latest(db, item, connection_id, chat_id)
    if (
        connection is None
        or connection.owner_id != item.owner_id
        or connection.integration_id != item.id
        or incoming is None
    ):
        raise service.error(404, "NOT_FOUND", "Доступный входящий чат не найден.")
    if not body.strip() or len(body) > 4096:
        raise service.error(
            422, "VALIDATION_ERROR", "Сообщение должно содержать от 1 до 4096 символов."
        )
    if reply_to_message_id is not None:
        from sqlalchemy import or_
        target=(await db.execute(select(TelegramBusinessMessage.id).where(
            TelegramBusinessMessage.owner_id==item.owner_id,TelegramBusinessMessage.integration_id==item.id,
            TelegramBusinessMessage.business_connection_id==connection_id,TelegramBusinessMessage.chat_id==chat_id,
            TelegramBusinessMessage.deleted_at.is_(None),or_(TelegramBusinessMessage.telegram_message_id==reply_to_message_id,
                TelegramBusinessMessage.reply_message_id==reply_to_message_id)))).first()
        if target is None:
            raise service.error(404,'TELEGRAM_REPLY_TARGET_UNAVAILABLE','Сообщение для ответа недоступно в этом чате.')
    state = availability(item, connection, incoming.sent_at)
    if not state["can_send"]:
        raise service.error(
            403
            if state["send_disabled_code"]
            in {"TELEGRAM_REPLY_DENIED", "TELEGRAM_REPLY_WINDOW_EXPIRED"}
            else 409,
            state["send_disabled_code"],
            "Отправка в этот чат сейчас недоступна.",
        )
    token = item.encrypted_token
    async with service.TelegramClient(decrypt_secret(token)) as client:
        # Fresh Telegram authority is mandatory, even when the browser's snapshot says open.
        connection = await service.verified_connection(
            db, item, client, connection_id, fresh=True
        )
        await db.commit()
        await db.refresh(item)
        incoming = await _latest(db, item, connection_id, chat_id)
        state = availability(item, connection, incoming.sent_at if incoming else None)
        if item.encrypted_token != token or not state["can_send"]:
            raise service.error(
                403,
                state["send_disabled_code"] or "TELEGRAM_NOT_CONFIGURED",
                "Отправка в этот чат сейчас недоступна.",
            )
        authorize(item, editing=editing)
        receipt = TelegramChatSend(
            owner_id=item.owner_id,
            integration_id=item.id,
            business_connection_id=connection_id,
            chat_id=chat_id,
            idempotency_key=key,
            request_hash=digest,
            send_status="sending",
        )
        db.add(receipt)
        receipt_owner_id = item.owner_id
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            existing = (
                await db.execute(
                    select(TelegramChatSend).where(
                        TelegramChatSend.owner_id == receipt_owner_id,
                        TelegramChatSend.idempotency_key == key,
                    )
                )
            ).scalar_one_or_none()
            if existing:
                return await replay(db, existing, digest)
            raise service.error(
                409, "VERSION_CONFLICT", "Подключение изменилось. Обновите чат."
            ) from None
        receipt_id, owner_id, integration_id = receipt.id, item.owner_id, item.id
        await db.refresh(item)
        current_connection = await db.get(
            TelegramBusinessConnection, connection_id, populate_existing=True
        )
        current_incoming = await _latest(db, item, connection_id, chat_id)
        current_state = availability(
            item,
            current_connection,
            current_incoming.sent_at if current_incoming else None,
        )
        if item.encrypted_token != token or not current_state["can_send"]:
            receipt.send_status = "failed"
            receipt.error_code = (
                current_state["send_disabled_code"] or "TELEGRAM_PAUSED"
            )
            receipt.version += 1
            await db.commit()
            raise service.error(
                409, receipt.error_code, "Подключение или доступность чата изменились."
            )
        authorize(item, editing=editing)
        if before_send or editing:
            try:
                if before_send:
                    await before_send()
                if editing:
                    await edit_target()
            except Exception:  # Source changed before I/O: this is a known unsent receipt.
                await db.execute(update(TelegramChatSend).where(TelegramChatSend.id == receipt_id).values(send_status="failed", error_code="COMMAND_STALE", version=TelegramChatSend.version + 1))
                await db.commit()
                raise
        try:
            reply_arguments={"reply_to_message_id":reply_to_message_id} if reply_to_message_id is not None else {}
            if edit_message_id is not None:
                sent = await client.edit_message_text(chat_id, edit_message_id, body, business_connection_id=connection_id)
            else:
                sent = await client.send_message(chat_id, body, business_connection_id=connection_id, **reply_arguments)
            if (
                not service.integer(sent.get("message_id"))
                or sent["message_id"] <= 0
                or (editing and sent["message_id"] != edit_message_id)
                or (
                    isinstance(sent.get("chat"), dict)
                    and sent["chat"].get("id") != chat_id
                )
            ):
                raise TelegramError("invalid_response")
        except TelegramError as exc:
            ambiguous = exc.code in {
                "timeout",
                "network_error",
                "invalid_response",
            } or (isinstance(exc.code, int) and exc.code >= 500)
            code = (
                "TELEGRAM_DELIVERY_UNKNOWN" if ambiguous else service.remote_code(exc)
            )
            if exc.code == 429:
                item.last_error_code = "TELEGRAM_RATE_LIMITED"
                item.lease_expires_at = now() + timedelta(
                    seconds=min(max(exc.retry_after or 30, 1), 86400)
                )
            authorize(item, editing=editing)
            await db.execute(
                update(TelegramChatSend)
                .where(
                    TelegramChatSend.id == receipt_id,
                    TelegramChatSend.send_status == "sending",
                )
                .values(
                    send_status="unknown" if ambiguous else "failed",
                    error_code=code,
                    version=TelegramChatSend.version + 1,
                )
            )
            await db.commit()
            raise service.error(
                503, code, "Проверьте переписку Telegram перед новой отправкой."
            ) from None
        # Disconnect/replacement while I/O was in flight must not resurrect purged data.
        await db.refresh(item)
        active = (
            await db.execute(
                select(TelegramChatSend)
                .where(TelegramChatSend.id == receipt_id)
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if active is None or item.encrypted_token != token or not item.enabled:
            raise service.error(
                503, "TELEGRAM_DELIVERY_UNKNOWN", "Проверьте переписку Telegram."
            )
        if editing:
            connection = await db.get(TelegramBusinessConnection, connection_id, populate_existing=True)
            incoming = await _latest(db, item, connection_id, chat_id)
            if not availability(item, connection, incoming.sent_at if incoming else None)["can_send"]:
                raise service.error(503, "TELEGRAM_DELIVERY_UNKNOWN", "Chat permissions changed")
        authorize(item, editing=editing)
        # A poll can observe the owner echo before sendMessage returns. Adopt its
        # canonical remote identity instead of inserting a duplicate conversation line.
        conditions = (
            TelegramBusinessMessage.owner_id == owner_id,
            TelegramBusinessMessage.integration_id == integration_id,
            TelegramBusinessMessage.business_connection_id == connection_id,
            TelegramBusinessMessage.chat_id == chat_id,
            TelegramBusinessMessage.telegram_message_id == sent["message_id"],
        )
        outgoing = (
            await db.execute(select(TelegramBusinessMessage).where(*conditions).execution_options(populate_existing=editing))
        ).scalar_one_or_none()
        if outgoing is None and editing:
            raise service.error(503, "TELEGRAM_DELIVERY_UNKNOWN", "Command disappeared")
        if outgoing is None:
            outgoing = TelegramBusinessMessage(
                owner_id=owner_id,
                integration_id=integration_id,
                business_connection_id=connection_id,
                chat_id=chat_id,
                telegram_message_id=sent["message_id"],
                sender_id=item.owner_telegram_id,
                chat_title=incoming.chat_title if incoming else "",
                text=body,
                sent_at=now(),
                direction=direction,
                draft_status="none",
                reply_to_telegram_message_id=reply_to_message_id,
            )
            try:
                async with db.begin_nested():
                    db.add(outgoing)
                    await db.flush()
            except IntegrityError:
                outgoing = (
                    await db.execute(select(TelegramBusinessMessage).where(*conditions).execution_options(populate_existing=editing))
                ).scalar_one()
        if editing:
            if outgoing is None or outgoing.deleted_at:
                raise service.error(503, "TELEGRAM_DELIVERY_UNKNOWN", "Command disappeared")
            # Never overwrite an owner edit/deletion observed during remote I/O.
            if outgoing.version != edit_source_version and outgoing.text != body:
                raise service.error(503, "TELEGRAM_DELIVERY_UNKNOWN", "Command changed")
            changed = await db.execute(update(TelegramBusinessMessage).where(
                TelegramBusinessMessage.id == outgoing.id,
                TelegramBusinessMessage.version == outgoing.version,
                TelegramBusinessMessage.deleted_at.is_(None),
            ).values(text=body, edited_at=now(), direction="outbound",
                     version=TelegramBusinessMessage.version + 1)
                .returning(TelegramBusinessMessage.id).execution_options(synchronize_session=False))
            if changed.scalar_one_or_none() is None:
                raise service.error(503, "TELEGRAM_DELIVERY_UNKNOWN", "Command changed")
        if direction == "outbound" and not editing:
            outgoing.direction = "outbound"
        if reply_to_message_id is not None and outgoing.reply_to_telegram_message_id is None:
            outgoing.reply_to_telegram_message_id = reply_to_message_id
            outgoing.version += 1
        active.message_id = outgoing.id
        active.send_status = "sent"
        active.version += 1
        await db.commit()
        await db.refresh(outgoing)
        return outgoing


async def recover_stale_sends(db: AsyncSession) -> None:
    """The connector marks abandoned claims unknown; it never replays their I/O."""
    cutoff = now() - timedelta(minutes=3)
    pending = (
        (
            await db.execute(
                select(TelegramChatSend).where(
                    TelegramChatSend.send_status == "sending",
                    TelegramChatSend.updated_at < cutoff,
                )
            )
        )
        .scalars()
        .all()
    )
    for receipt in pending:
        item = await db.get(TelegramIntegration, receipt.integration_id)
        if item is None or item.owner_id != receipt.owner_id:
            continue
        authorize(item)
        await db.execute(
            update(TelegramChatSend)
            .where(
                TelegramChatSend.id == receipt.id,
                TelegramChatSend.version == receipt.version,
                TelegramChatSend.send_status == "sending",
            )
            .values(
                send_status="unknown",
                error_code="TELEGRAM_DELIVERY_UNKNOWN",
                version=receipt.version + 1,
            )
        )
