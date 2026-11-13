"""Owner-only controls and callbacks for Telegram task suggestions."""
from __future__ import annotations

import re
from datetime import UTC, datetime
from uuid import UUID

from app.ai import actions
from app.ai.errors import PolicyDenied
from app.core.models import AIAction, AIRun
from app.domains.recurrence import utc
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .telegram_models import (
    TelegramBusinessConnection,
    TelegramBusinessMessage,
    TelegramIntegration,
)
from .telegram_personal import authorize
from .telegram_task_suggestions import (
    DAILY_LIMIT,
    FEATURE,
    _expire,
    daily_attempts,
    invalidate_suggestions,
    lock_integration,
)

_CALLBACK = re.compile(r"ats:(a|r):([0-9a-fA-F-]{36})\Z")
_MAX_TELEGRAM_ID = 2**52


async def handle_task_suggestions(db: AsyncSession, item: TelegramIntegration, body: str, at: datetime) -> str:
    """Configure one known, owner-bound private Business chat; new messages only."""
    parts = body.split()
    mode = parts[0].casefold() if parts else 'status'
    if mode == 'status' and len(parts) <= 1:
        authorize(item, 'telegram.task_suggestions')
        await _expire(db, item.id, at)
        used = await daily_attempts(db, item.id, at)
        known_chats = await _known_chats(db, item)
        enabled_at = item.task_suggestions_enabled_at
        enabled_chat = item.task_suggestions_chat_id
        if enabled_chat is None or enabled_at is None:
            state = 'Предложения задач выключены.'
        else:
            enabled = utc(enabled_at).astimezone(UTC)
            state = (f"Предложения задач включены для чата {enabled_chat} с "
                     f"{enabled:%Y-%m-%d %H:%M UTC}.")
        listing = ', '.join(map(str, known_chats)) if known_chats else 'нет'
        return (f"{state}\nИзвестные доступные личные чаты: {listing}.\n"
                f"Осталось попыток сегодня: {max(0, DAILY_LIMIT-used)} из {DAILY_LIMIT}.")
    if mode == 'on' and len(parts) == 2 and re.fullmatch(r'[0-9]{1,16}', parts[1]):
        authorize(item, 'telegram.task_suggestions')
        locked_item = await lock_integration(db, item.id)
        if locked_item is None:
            return 'Telegram-интеграция недоступна.'
        item = locked_item
        chat_id = int(parts[1])
        if not 0 < chat_id <= _MAX_TELEGRAM_ID:
            return 'ID чата должен быть положительным числом.'
        if not item.enabled or item.deleted_at or not item.encrypted_token or not item.owner_telegram_id:
            return 'Сначала привяжите владельца и включите Telegram-бота.'
        if item.task_suggestions_chat_id == chat_id and item.task_suggestions_enabled_at is not None:
            return f'Предложения задач уже включены для чата {chat_id}; дата начала не изменена.'
        if item.task_suggestions_chat_id not in (None, chat_id):
            return 'Сначала выключите предложения для текущего чата командой /task_suggestions off.'
        known = (await db.execute(select(TelegramBusinessMessage.chat_id).join(
            TelegramBusinessConnection,
            TelegramBusinessConnection.id == TelegramBusinessMessage.business_connection_id,
        ).where(TelegramBusinessMessage.integration_id == item.id,
            TelegramBusinessMessage.owner_id == item.owner_id,
            TelegramBusinessMessage.chat_id == chat_id,
            TelegramBusinessMessage.direction == 'inbound',
            TelegramBusinessMessage.deleted_at.is_(None),
            TelegramBusinessConnection.integration_id == item.id,
            TelegramBusinessConnection.owner_id == item.owner_id,
            TelegramBusinessConnection.telegram_user_id == item.owner_telegram_id,
            TelegramBusinessConnection.enabled.is_(True),
            TelegramBusinessConnection.rights['can_read_messages'].as_boolean().is_(True),
        ).limit(1))).first()
        if not known:
            return 'Чат не найден среди доступных личных Business-чатов.'
        item.task_suggestions_chat_id = chat_id
        item.task_suggestions_enabled_at = at
        item.version += 1
        return f'Предложения задач включены для чата {chat_id} с текущего момента.'
    if mode == 'off' and len(parts) == 1:
        authorize(item, 'telegram.task_suggestions')
        locked_item = await lock_integration(db, item.id)
        if locked_item is None:
            return 'Telegram-интеграция недоступна.'
        item = locked_item
        if not item.enabled or item.deleted_at or not item.owner_telegram_id:
            return 'Действие недоступно: привяжите владельца и включите Telegram-бота.'
        await invalidate_suggestions(db, integration_id=item.id, at=at)
        item.task_suggestions_chat_id = None
        item.task_suggestions_enabled_at = None
        item.version += 1
        return 'Предложения задач выключены; ожидавшие подтверждения отменены.'
    return 'Используйте /task_suggestions [status], /task_suggestions on <chat_id> или /task_suggestions off.'


async def _known_chats(db: AsyncSession, item: TelegramIntegration) -> list[int]:
    if not item.owner_telegram_id:
        return []
    rows = (await db.execute(select(TelegramBusinessMessage.chat_id).join(
        TelegramBusinessConnection,
        TelegramBusinessConnection.id == TelegramBusinessMessage.business_connection_id,
    ).where(TelegramBusinessMessage.integration_id == item.id,
        TelegramBusinessMessage.owner_id == item.owner_id,
        TelegramBusinessMessage.direction == 'inbound',
        TelegramBusinessMessage.deleted_at.is_(None),
        TelegramBusinessConnection.integration_id == item.id,
        TelegramBusinessConnection.owner_id == item.owner_id,
        TelegramBusinessConnection.telegram_user_id == item.owner_telegram_id,
        TelegramBusinessConnection.enabled.is_(True),
        TelegramBusinessConnection.rights['can_read_messages'].as_boolean().is_(True),
    ).distinct().order_by(TelegramBusinessMessage.chat_id))).all()
    return sorted({int(row.chat_id) for row in rows})


def _callback_identity(item: TelegramIntegration, raw: dict) -> tuple[str, int, str, str] | None:
    query_value = raw.get('id')
    if not isinstance(query_value, str):
        return None
    try:
        query_size = len(query_value.encode('utf-8')) if isinstance(query_value, str) else 0
    except UnicodeEncodeError:
        return None
    if not 1 <= query_size <= 256:
        return None
    sender = raw.get('from')
    message = raw.get('message')
    if not isinstance(sender, dict) or type(sender.get('id')) is not int or sender.get('is_bot') is not False:
        return None
    if sender['id'] != item.owner_telegram_id or not isinstance(message, dict):
        return None
    chat = message.get('chat')
    bot = message.get('from')
    if (not isinstance(chat, dict) or chat.get('type') != 'private'
            or type(chat.get('id')) is not int or chat.get('id') != item.owner_telegram_id
            or not isinstance(bot, dict) or bot.get('is_bot') is not True
            or type(bot.get('id')) is not int or bot.get('id') != item.bot_id):
        return None
    message_id = message.get('message_id')
    if type(message_id) is not int or not 0 < message_id <= _MAX_TELEGRAM_ID:
        return None
    data = raw.get('data')
    if not isinstance(data, str):
        return None
    try:
        if len(data.encode('utf-8')) > 64:
            return None
    except UnicodeEncodeError:
        return None
    match = _CALLBACK.fullmatch(data)
    if not match:
        return None
    try:
        action_id = str(UUID(match[2]))
    except ValueError:
        return None
    checked_query_id: str = query_value
    checked_message_id: int = message_id
    operation_match: str | None = match[1]
    if operation_match is None:
        return None
    operation: str = operation_match
    return checked_query_id, checked_message_id, operation, action_id


async def handle_task_callback(db: AsyncSession, item: TelegramIntegration, raw: dict, client) -> None:
    """Consume verified owner callbacks after poll receipt/cursor commit."""
    item = await db.get(TelegramIntegration, item.id, populate_existing=True) or item
    owner_telegram_id = item.owner_telegram_id
    identity = _callback_identity(item, raw)
    if identity is None:
        return
    query_id, message_id, operation, action_id = identity
    try:
        authorize(item, 'telegram.notify_owner', external=True)
    except PolicyDenied:
        return
    if not item.enabled or item.deleted_at or not item.encrypted_token or not item.owner_telegram_id:
        await _respond(db, client, query_id, 'Действие недоступно.', owner_telegram_id, message_id)
        return
    try:
        action = await actions.owned_action(db, item.owner_id, action_id)
    except HTTPException as exc:
        await db.rollback()
        await _respond(db, client, query_id, _terminal_text(exc, None), owner_telegram_id, message_id)
        return
    run = await db.get(AIRun, action.run_id)
    if (action.source_kind != FEATURE or not action.source_id or action.tool != 'create_task'
            or not run or run.owner_id != item.owner_id
            or run.tool_scope_json.get('feature') != FEATURE
            or run.tool_scope_json.get('integration_id') != item.id
            or run.tool_scope_json.get('source_id') != action.source_id):
        await _respond(db, client, query_id, 'Предложение устарело или недоступно.', owner_telegram_id, message_id)
        return
    # Expire using the worker's feature/integration predicate before either
    # common action operation. This makes expiry terminal without tool execution.
    expiry_now = datetime.now(UTC)
    if action.status == 'pending' and action.expires_at and utc(action.expires_at) <= expiry_now:
        await _expire(db, item.id, expiry_now)
        await db.commit()
    try:
        result = (await actions.approve_action(db, item.owner_id, action_id) if operation == 'a'
                  else await actions.reject_action(db, item.owner_id, action_id))
        text = _result_text(result)
    except HTTPException as exc:
        await db.rollback()
        action = await db.get(AIAction, action_id, populate_existing=True)
        await db.commit()
        text = _terminal_text(exc, action)
    # Mutation service commits before UI cleanup. Notification failures never replay it.
    await _respond(db, client, query_id, text, owner_telegram_id, message_id)


def _result_text(action: AIAction) -> str:
    if action.status == 'approved':
        result = action.result_json or {}
        task_id = result.get('id')
        if result.get('kind') == 'task' and isinstance(task_id, str):
            return f'Задача создана. ID: {task_id}'
    if action.status == 'rejected':
        return 'Предложение отклонено.'
    return _terminal_text(None, action)


def _terminal_text(error: HTTPException | None, action: AIAction | None) -> str:
    code = error.detail.get('code', '') if error and isinstance(error.detail, dict) else ''
    result = action.result_json or {} if action else {}
    error_code = (result.get('error') or {}).get('code', '') if isinstance(result, dict) else ''
    if code == 'ACTION_EXPIRED' or error_code == 'ACTION_EXPIRED':
        return 'Предложение истекло.'
    if code == 'NOT_FOUND':
        return 'Предложение не найдено или уже удалено.'
    if code == 'ACTION_REJECTED' or (action and action.status == 'rejected'):
        return 'Предложение отклонено.'
    if action and action.status == 'approved':
        task_id = result.get('id')
        return f'Задача уже создана. ID: {task_id}' if result.get('kind') == 'task' and task_id else 'Предложение уже обработано.'
    if error_code == 'ACTION_SOURCE_STALE':
        return 'Источник изменился; предложение устарело.'
    return 'Предложение уже обработано или недоступно.'


async def _answer(client, query_id: str, text: str) -> None:
    try:
        await client.answer_callback_query(query_id, text[:200])
    except Exception:  # noqa: BLE001 - answer is UI-only and may not replay an action
        return


async def _remove_buttons(client, chat_id: int, message_id: int) -> None:
    try:
        await client.edit_message_reply_markup(chat_id, message_id, {'inline_keyboard': []})
    except Exception:  # noqa: BLE001 - callbacks are at-most-once; don't replay mutation
        return


async def _respond(db: AsyncSession, client, query_id: str, text: str,
                   owner_telegram_id: int | None, message_id: int) -> None:
    await db.commit()
    await _answer(client, query_id, text)
    if owner_telegram_id is not None:
        await _remove_buttons(client, owner_telegram_id, message_id)
