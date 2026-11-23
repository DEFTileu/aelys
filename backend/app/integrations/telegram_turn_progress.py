"""Editable Telegram turn messages and durable, message-bound cancellation."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from collections.abc import Awaitable, Callable, Coroutine, Mapping, Sequence
from decimal import Decimal
from typing import Any, TypeGuard

from app.ai.crypto import decrypt_secret, encrypt_secret
from app.ai.egress import SensitiveDataBlocked, ensure_safe_payload
from app.ai.errors import PolicyDenied, RunCancelled
from app.ai.models import UsageRecord
from app.core import db as database
from app.core.models import AIRun, now
from sqlalchemy import case, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .telegram_answer_format import MessageEntity, presented_answer_message
from .telegram_models import TelegramIntegration, TelegramPersonalJob
from .telegram_personal import authorize
from .telegram_transport import TelegramClient, TelegramError

logger = logging.getLogger(__name__)
PREFIX = "turn:"
_CALLBACK = re.compile(r"turn:stop:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})")
WORKING = "🤔 Готовлю ответ…"
_THINKING_EMOJI_ID = "5188364800450670260"
_SEARCH_EMOJI_ID = "5199622193201333717"
STOPPED = "Остановлено. Уже выполненные действия сохранены."
CLEAR: dict[str, Any] = {"inline_keyboard": []}
CANCELLED = "CANCELLED"
_active: dict[str, asyncio.Task[Any]] = {}


def _active_binding(item: TelegramIntegration) -> bool:
    return bool(item.enabled and not item.deleted_at and item.encrypted_token and item.owner_telegram_id)


def _message_hash(value: str | int) -> str:
    return hashlib.sha256(str(value).encode()).hexdigest()


def _bounded_string(value: Any) -> TypeGuard[str]:
    if not isinstance(value, str):
        return False
    try:
        return 1 <= len(value.encode()) <= 256
    except UnicodeError:
        return False


async def guard_running(db: AsyncSession, run_id: str, owner_id: str) -> None:
    """Serialize tool transactions and finalization with the Stop transition."""
    result = await db.scalar(
        update(AIRun)
        .where(AIRun.id == run_id, AIRun.owner_id == owner_id, AIRun.status == "running", AIRun.deleted_at.is_(None))
        .values(status=AIRun.status)
        .returning(AIRun.id)
        .execution_options(synchronize_session=False)
    )
    if result is None:
        raise RunCancelled("run cancelled")


async def run_cancelled(run_id: str, owner_id: str) -> bool:
    # The provider transport may poll while delivering a stream delta. Its
    # watcher must never share the worker's session or commit a tool mutation.
    async with database.SessionLocal() as db:
        return await db.scalar(
            select(AIRun.status).where(AIRun.id == run_id, AIRun.owner_id == owner_id, AIRun.deleted_at.is_(None))
        ) != "running"


async def fail_run(
    db: AsyncSession, run_id: str, owner_id: str, usage: Sequence[UsageRecord],
) -> bool:
    """Close the run and keep measured usage even if Stop won the race."""
    from app.ai import api as ai_api

    cancelled = AIRun.status == "cancelled"
    values: dict[str, Any] = {
        "status": case((cancelled, "cancelled"), else_="failed"),
        "completed_at": case((cancelled, AIRun.completed_at), else_=now()),
        "version": AIRun.version + 1,
    }
    if usage:
        values.update(
            cost_estimate=sum((record.estimated_cost for record in usage), Decimal(0)),
            token_counts={
                "input": sum(record.usage.input_tokens for record in usage),
                "output": sum(record.usage.output_tokens for record in usage),
            },
        )
    status = await db.scalar(
        update(AIRun)
        .where(
            AIRun.id == run_id, AIRun.owner_id == owner_id, AIRun.deleted_at.is_(None),
            AIRun.status.in_(("running", "cancelled")),
        )
        .values(**values)
        .returning(AIRun.status)
        .execution_options(synchronize_session=False)
    )
    if status == "cancelled":
        await ai_api._persist_event(
            db, run_id, f'event: ai.run.cancelled\ndata: {{"run_id":"{run_id}"}}\n\n',
        )
        return True
    return False


async def execute_turn[T](run_id: str, turn: Coroutine[Any, Any, T]) -> T:
    task = asyncio.create_task(turn)
    _active[run_id] = task
    try:
        return await task
    except asyncio.CancelledError:
        if (current := asyncio.current_task()) is not None and not current.cancelling():
            raise RunCancelled("run cancelled") from None
        raise
    finally:
        _active.pop(run_id, None)


class TurnProgress:
    def __init__(self, *, guest: bool = False) -> None:
        self.guest = guest
        self.message: str | int | None = None
        self.run_id: str | None = None
        self.owner_id: str | None = None
        self.integration_id: str | None = None
        self.owner_chat: int | None = None
        self.bot_id: int | None = None
        self.delivery_status = "pending"
        self._last_status = WORKING
        self._trace_url: str | None = None
        self._custom_emoji_enabled = True

    async def _with_status_emoji[T](
        self, send: Callable[[Sequence[Mapping[str, object]]], Awaitable[T]],
        entities: Sequence[Mapping[str, object]], emoji_id: str | None,
    ) -> T:
        if self._custom_emoji_enabled and emoji_id is not None:
            emoji: MessageEntity = {
                "type": "custom_emoji", "offset": 0, "length": 2, "custom_emoji_id": emoji_id,
            }
            try:
                return await send([emoji, *entities])
            except TelegramError as exc:
                if exc.code != 400:
                    raise
                self._custom_emoji_enabled = False
        return await send(entities)

    @classmethod
    def restore_guest(cls, item: TelegramIntegration, run: AIRun) -> TurnProgress | None:
        binding = (run.tool_scope_json or {}).get("telegram_progress")
        if (
            not isinstance(binding, dict) or binding.get("guest") is not True
            or run.owner_id != item.owner_id or binding.get("integration_id") != item.id
            or binding.get("owner_chat") != item.owner_telegram_id or binding.get("bot_id") != item.bot_id
        ):
            return None
        try:
            target = decrypt_secret(binding["inline_target"])
        except Exception:  # noqa: BLE001 - unreadable encrypted target is never used
            return None
        if not _bounded_string(target) or binding.get("message_hash") != _message_hash(target):
            return None
        progress = cls(guest=True)
        progress.message, progress.run_id, progress.owner_id = target, run.id, run.owner_id
        progress.integration_id, progress.owner_chat, progress.bot_id = item.id, item.owner_telegram_id, item.bot_id
        return progress

    async def start(
        self, db: AsyncSession, item: TelegramIntegration, run: AIRun, *, guest_query_id: str | None = None,
    ) -> None:
        from .telegram_service import TelegramClient

        self.run_id, self.owner_id = run.id, run.owner_id
        self.integration_id, self.owner_chat, self.bot_id = item.id, item.owner_telegram_id, item.bot_id
        if not _active_binding(item) or (self.guest and not guest_query_id):
            return
        markup = {"inline_keyboard": [[{"text": "Остановить", "callback_data": f"{PREFIX}stop:{run.id}"}]]}
        self.delivery_status = "unknown"
        if re.fullmatch(r"[A-Za-z0-9_]{1,64}", item.bot_username or ""):
            self._trace_url = f"https://t.me/{item.bot_username}?startapp=run__{run.id}"
        text, entities = presented_answer_message(WORKING, self._trace_url)
        try:
            authorize(item, "telegram.guest_reply" if self.guest else "telegram.notify_owner", external=True)
            async with asyncio.timeout(5), TelegramClient(decrypt_secret(item.encrypted_token or "")) as client:
                async def send(status_entities: Sequence[Mapping[str, object]]) -> str | int | None:
                    if self.guest:
                        response = await client.answer_guest_query(
                            guest_query_id or "", text, result_id=run.id, entities=status_entities,
                            reply_markup=markup,
                        )
                        value = response.get("inline_message_id")
                        return value if _bounded_string(value) else None
                    if self.owner_chat is not None:
                        response = await client.send_message(
                            self.owner_chat, text, entities=status_entities, reply_markup=markup,
                        )
                        value = response.get("message_id")
                        return value if type(value) is int and 0 < value <= 2**52 else None
                    return None

                self.message = await self._with_status_emoji(send, entities, _THINKING_EMOJI_ID)
        except TelegramError as exc:
            if type(exc.code) is int and 400 <= exc.code < 500:
                self.delivery_status = "failed"
        except PolicyDenied:
            self.delivery_status = "failed"
        except Exception:  # noqa: BLE001 - transport details are private, result may be ambiguous
            logger.info("Telegram progress message unavailable")
        if self.message is None:
            return
        run.tool_scope_json = {
            **run.tool_scope_json,
            "telegram_progress": {
                "integration_id": item.id,
                "owner_chat": self.owner_chat,
                "bot_id": self.bot_id,
                "guest": self.guest,
                "message_hash": _message_hash(self.message),
                **({"inline_target": encrypt_secret(self.message)} if isinstance(self.message, str) else {}),
            },
        }
        await db.commit()
        self.delivery_status = "sending"

    async def search(self, query: Any, *, known_secrets: tuple[str, ...]) -> None:
        # Collapse formatting/control characters before displaying generated text.
        query = " ".join("".join(
            char for char in query if char.isprintable() or char.isspace()
        ).split()) if isinstance(query, str) else ""
        try:
            ensure_safe_payload(query, known_secrets=known_secrets)
        except SensitiveDataBlocked:
            query = ""
        text = f"🔍 Поиск в вебе: {query[:300]}" if query else "🔍 Поиск в вебе…"
        if text != self._last_status:
            # A cancelled progress update must settle before the terminal edit
            # clears its keyboard.
            literal = re.sub(r"([\\`*_\[\]])", r"\\\1", text)
            status, entities = presented_answer_message(literal, self._trace_url)
            edit = asyncio.create_task(self._edit(status, entities=entities, clear=False, emoji_id=_SEARCH_EMOJI_ID))
            try:
                if await asyncio.shield(edit):
                    self._last_status = text
            except asyncio.CancelledError:
                await asyncio.gather(edit, return_exceptions=True)
                raise

    async def finish(self, text: str, entities: Sequence[Mapping[str, object]] = ()) -> bool:
        return await self._edit(text, entities=entities, clear=True)

    async def _edit(
        self, text: str, *, entities: Sequence[Mapping[str, object]] = (), clear: bool,
        emoji_id: str | None = None,
    ) -> bool:
        from .telegram_service import TelegramClient

        if self.message is None or not self.integration_id or not self.run_id:
            return False
        try:
            async with database.SessionLocal() as db:
                item = await db.get(TelegramIntegration, self.integration_id)
                if (
                    not item or not _active_binding(item) or item.owner_id != self.owner_id
                    or item.owner_telegram_id != self.owner_chat or item.bot_id != self.bot_id
                ):
                    return False
                authorize(item, "telegram.guest_reply" if self.guest else "telegram.notify_owner", external=True)
                token = decrypt_secret(item.encrypted_token or "")
            markup = CLEAR if clear else {
                "inline_keyboard": [[{"text": "Остановить", "callback_data": f"{PREFIX}stop:{self.run_id}"}]],
            }
            async with TelegramClient(token) as client:
                async def edit(status_entities: Sequence[Mapping[str, object]]) -> bool:
                    if isinstance(self.message, str):
                        return await client.edit_inline_message_text(
                            self.message, text, entities=status_entities, reply_markup=markup,
                        )
                    if self.message is not None and self.owner_chat is not None:
                        await client.edit_message_text(
                            self.owner_chat, self.message, text, entities=status_entities, reply_markup=markup,
                        )
                        return True
                    return False

                for attempt in range(2 if clear else 1):
                    try:
                        async with asyncio.timeout(3 if clear else 5):
                            return await self._with_status_emoji(edit, entities, emoji_id)
                    except (TelegramError, TimeoutError) as exc:
                        transient = isinstance(exc, TimeoutError) or (
                            isinstance(exc, TelegramError) and (
                                exc.code in {"timeout", "network_error", "invalid_response"}
                                or (isinstance(exc.code, int) and exc.code >= 500)
                            )
                        )
                        if not clear or attempt or not transient:
                            raise
                        # A single bounded retry of the exact same edit is safe
                        # even if Telegram applied the first request.
        except Exception:  # noqa: BLE001 - do not send a second answer after a possibly successful edit
            logger.info("Telegram progress edit unavailable")
        return False


def _callback_target(item: TelegramIntegration, callback: Mapping[str, Any], *, guest: bool) -> str | int | None:
    if guest:
        inline = callback.get("inline_message_id")
        return inline if _bounded_string(inline) and callback.get("message") is None else None
    message = callback.get("message")
    if not isinstance(message, Mapping) or callback.get("inline_message_id") is not None:
        return None
    chat, sender = message.get("chat"), message.get("from")
    identifier = message.get("message_id")
    if (
        isinstance(chat, Mapping) and chat.get("type") == "private"
        and type(chat.get("id")) is int and chat["id"] == item.owner_telegram_id
        and isinstance(sender, Mapping) and sender.get("is_bot") is True
        and type(sender.get("id")) is int and sender["id"] == item.bot_id
        and type(identifier) is int and 0 < identifier <= 2**52
    ):
        return identifier
    return None


async def handle_turn_callback(
    db: AsyncSession, item: TelegramIntegration, callback: Mapping[str, Any], client: TelegramClient,
) -> bool:
    """Consume the turn namespace, accepting Stop only on its original message."""
    data = callback.get("data")
    if not isinstance(data, str) or not data.startswith(PREFIX):
        return False
    match = _CALLBACK.fullmatch(data)
    query_id, sender = callback.get("id"), callback.get("from")
    if not match or not _bounded_string(query_id) or not isinstance(sender, Mapping):
        return True
    current = await db.get(TelegramIntegration, item.id, populate_existing=True)
    if (
        not current or current.owner_id != item.owner_id or not _active_binding(current)
        or sender.get("is_bot") is not False or type(sender.get("id")) is not int
        or sender["id"] != current.owner_telegram_id
    ):
        return True
    run_id = match[1]
    run = await db.get(AIRun, run_id)
    binding = (run.tool_scope_json or {}).get("telegram_progress") if run else None
    if not run or run.owner_id != current.owner_id or run.deleted_at:
        return True
    if not isinstance(binding, dict):
        if run.status == "running" and (run.idempotency_key or "").startswith(("telegram-personal:", "telegram-guest:")):
            await db.commit()
            try:
                await client.answer_callback_query(query_id, "Кнопка ещё готовится. Нажми ещё раз.")
            except TelegramError:
                logger.info("Telegram Stop acknowledgement unavailable")
        return True
    guest = binding.get("guest") is True
    target = _callback_target(current, callback, guest=guest)
    if (
        target is None or binding.get("integration_id") != current.id
        or binding.get("owner_chat") != current.owner_telegram_id or binding.get("bot_id") != current.bot_id
        or binding.get("message_hash") != _message_hash(target)
    ):
        return True
    try:
        authorize(current, "ai.guest.write" if guest else "ai.personal.write")
        authorize(current, "telegram.guest_reply" if guest else "telegram.notify_owner", external=True)
    except PolicyDenied:
        return True

    # A personal interruption already has a durable recovery notice. If the
    # owner taps its stale button, clear that original message in place as well.
    interrupted = not guest and run.status in {"failed", "cancelled"} and bool(await db.scalar(
        select(TelegramPersonalJob.id).where(
            TelegramPersonalJob.run_id == run_id,
            TelegramPersonalJob.integration_id == current.id,
            TelegramPersonalJob.owner_id == current.owner_id,
            TelegramPersonalJob.error_code == "AI_INTERRUPTED",
            TelegramPersonalJob.deleted_at.is_(None),
        )
    ))
    stopped = await db.scalar(
        update(AIRun)
        .where(AIRun.id == run_id, AIRun.owner_id == current.owner_id, AIRun.status == "running", AIRun.deleted_at.is_(None))
        .values(status="cancelled", completed_at=now(), version=AIRun.version + 1)
        .returning(AIRun.id)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    task = _active.get(run_id)
    if stopped and task and not task.done():
        task.cancel()
    try:
        await client.answer_callback_query(query_id, "Останавливаю…" if stopped else "Запрос уже завершён.")
    except Exception:  # noqa: BLE001 - acknowledgement must never replay cancellation
        logger.info("Telegram Stop acknowledgement unavailable")
    if interrupted and isinstance(target, int) and current.owner_telegram_id is not None:
        try:
            async with asyncio.timeout(5):
                await client.edit_message_text(
                    current.owner_telegram_id, target,
                    STOPPED if run.status == "cancelled" else "Запрос прерван. Уже выполненные действия сохранены.",
                    reply_markup=CLEAR,
                )
        except Exception:  # noqa: BLE001 - recovered jobs are terminal regardless of UI
            logger.info("Telegram interrupted progress edit unavailable")
    return True
