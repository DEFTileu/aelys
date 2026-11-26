"""Allowlisted owner diagnostics: never expose exception text or provider bodies."""
from __future__ import annotations

from typing import TYPE_CHECKING

from app.ai.errors import AIError, ProviderError
from fastapi import HTTPException

from .telegram_transport import TelegramError

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from .telegram_models import TelegramIntegration

_NOTICES = {
    "COMMAND_EMPTY": "Добавьте вопрос после /ask или /search либо ответьте командой на сообщение/выделенную цитату.",
    "SEARCH_UNAVAILABLE": "Веб-поиск не дал подтверждённых источников. Ответ в чат не отправлен; попробуйте другой запрос или /ask.",
    "COMMAND_CONTEXT_CHANGED": "Ответ опубликован, но его источник изменился во время публикации. Он исключён из контекста; проверьте переписку.",
    "COMMAND_TOO_LONG": "Вопрос и ответ не помещаются в одно сообщение. Сократите команду и попробуйте снова; исходный текст сохранён.",
    "COMMAND_STALE": "Команда или подключение изменились. Ответ в чат не отправлен.",
    "COMMAND_INTERRUPTED": "Выполнение команды прервано. Проверьте переписку перед новой командой; автоматического повтора нет.",
    "TELEGRAM_DELIVERY_UNKNOWN": "Результат отправки ответа неизвестен. Проверьте переписку перед новой командой; автоматического повтора нет.",
    "PROVIDER_REQUIRED": "AI-провайдер не настроен или отключён. Выберите активного провайдера с сохранённым ключом в настройках Telegram.",
    "PROVIDER_ERROR": "Запрос к AI-провайдеру завершился ошибкой. Проверьте доступность провайдера, API-ключ и баланс.",
    "PROVIDER_AUTH_FAILED": "AI-провайдер отклонил авторизацию. Проверьте ключ и доступ к выбранной модели.",
    "PROVIDER_RATE_LIMITED": "AI-провайдер ограничил запросы. Проверьте лимит у провайдера.",
    "PROVIDER_REQUEST_REJECTED": "AI-провайдер отклонил параметры запроса. Проверьте модель и поддерживаемые возможности.",
    "PROVIDER_UPSTREAM_FAILED": "На стороне AI-провайдера произошёл сбой.",
    "MODEL_UNAVAILABLE": "Выбранная модель AI недоступна. Выберите другую модель в настройках Telegram.",
    "BUDGET_EXCEEDED": "Недостаточен бюджет AI для этой команды. Проверьте месячный лимит расходов провайдера.",
    "POLICY_DENIED": "Действие запрещено политикой доступа. Проверьте разрешения интеграции и содержание запроса.",
    "AI_UNAVAILABLE": "AI вернул пустой или неподдерживаемый ответ. Повторите запрос или выберите другую модель.",
    "AI_ERROR": "Не удалось получить ответ AI. При повторном сбое передайте код и идентификатор запроса разработчику.",
    "AI_TIMEOUT": "Превышено время ожидания AI. Проверьте результат перед повтором.",
    "AI_INTERRUPTED": "Запуск был прерван. Проверьте результат перед повторным запросом.",
    "TOOL_ERROR": "Инструмент не завершил операцию. Проверьте актуальные данные перед повтором.",
    "VALIDATION_ERROR": "AI передал инструменту некорректные параметры.",
    "SENSITIVE_DATA_BLOCKED": "Отправка запроса провайдеру заблокирована: в запросе или его контексте обнаружены чувствительные данные.",
    "TRANSCRIPTION_NOT_CONFIGURED": "Распознавание голоса не настроено. Добавьте ключ и модель Transcription в настройках AI.",
    "TRANSCRIPTION_UNAVAILABLE": "Не удалось распознать голос. Проверьте ключ и модель Transcription.",
    "MEDIA_TOO_LARGE": "Файл слишком большой: голос, аудио и PDF — до 20 МБ, фото — до 10 МБ, текст — до 20 000 символов.",
    "MEDIA_UNSUPPORTED": "Тип файла не поддерживается.",
    "MEDIA_INVALID": "Не удалось получить файл из Telegram. Отправьте его заново.",
    "MEDIA_TEXT_INVALID": "Не удалось прочитать текст. Отправьте файл в UTF-8.",
    "MEDIA_MODEL_UNAVAILABLE": "Выбранная модель не поддерживает фото или PDF. Проверьте возможности модели.",
    "BUSINESS_AUDIO_UNSUPPORTED": "В чате есть голосовое сообщение или аудио. Автоответчик передал переписку владельцу.",
    "BUSINESS_MEDIA_LIMIT": "В ожидающих ответа сообщениях больше двух фотографий. Проверьте переписку вручную.",
    "BUSINESS_MEDIA_CONTEXT_LIMIT": "Фото не поместилось в контекст автоответа. Проверьте переписку вручную.",
    "TELEGRAM_MEDIA_UNAVAILABLE": "Автоответчик не смог загрузить вложение из Telegram. Проверьте переписку вручную.",
    "TELEGRAM_MEDIA_TIMEOUT": "Telegram не передал вложение вовремя. Проверьте переписку вручную.",
    "BUSINESS_HANDOFF": "Автоответчик передал переписку владельцу. Более точная причина не сохранена.",
    "TELEGRAM_REPLY_DENIED": "Telegram не разрешает ответ в этом чате. Проверьте разрешение на ответы у Business-бота.",
    "TELEGRAM_REPLY_WINDOW_EXPIRED": "Истёк разрешённый Telegram срок ответа. Дождитесь нового сообщения собеседника.",
    "TELEGRAM_BINDING_REQUIRED": "Не подтверждена привязка владельца или Business-подключение. Проверьте Connection в настройках Telegram.",
    "TELEGRAM_PAUSED": "Интеграция Telegram приостановлена. Нажмите Resume в её настройках.",
    "TELEGRAM_TOKEN_INVALID": "Telegram отклонил токен бота. Проверьте токен в BotFather и обновите подключение.",
    "TELEGRAM_FORBIDDEN": "Telegram запретил действие. Проверьте, что бот не заблокирован и имеет доступ к чату.",
    "TELEGRAM_RATE_LIMITED": "Telegram временно ограничил запросы. Повторите команду позже.",
    "TELEGRAM_TIMEOUT": "Telegram не ответил вовремя. Проверьте переписку перед повтором команды.",
    "TELEGRAM_UNAVAILABLE": "Не удалось связаться с Telegram. Проверьте переписку перед повтором команды.",
    "TELEGRAM_POLL_CONFLICT": "Другой процесс уже получает сообщения этого бота. Оставьте только один запущенный обработчик.",
    "COMMAND_FAILED": "Внутренняя ошибка Aelys. Проверьте переписку перед повтором и передайте номер команды разработчику.",
}


def safe_code(candidate: object, fallback: str = "COMMAND_FAILED") -> str:
    return candidate if isinstance(candidate, str) and candidate in _NOTICES else fallback


def error_code(exc: Exception, fallback: str = "COMMAND_FAILED") -> str:
    candidate = None
    if isinstance(exc, ProviderError):
        status = exc.http_status
        if status in {401, 403}:
            return "PROVIDER_AUTH_FAILED"
        if status == 429:
            return "PROVIDER_RATE_LIMITED"
        if status is not None and 500 <= status <= 599:
            return "PROVIDER_UPSTREAM_FAILED"
        if status is not None and 400 <= status <= 499:
            return "PROVIDER_REQUEST_REJECTED"
        return "PROVIDER_ERROR"
    if isinstance(exc, HTTPException) and isinstance(exc.detail, dict):
        candidate = exc.detail.get("code")
    elif isinstance(exc, AIError):
        candidate = exc.code
    elif isinstance(exc, TelegramError):
        from .telegram_service import remote_code
        candidate = remote_code(exc)
    return safe_code(candidate, fallback)


def notice(code: str, command_id: str | None = None) -> str:
    code = safe_code(code)
    reference = f"\nКоманда: {command_id}" if command_id else ""
    return f"{_NOTICES[code]}\nКод: {code}{reference}"


def personal_failure_notice(code: str, job_id: str, run_id: str | None, writes: int, tasks_created: int) -> str:
    run = f"\nЗапуск: {run_id}" if run_id else ""
    effects = ""
    if writes:
        effects = f"\nДо сбоя подтверждено изменений: {writes}."
        if tasks_created:
            effects += f" Создано задач: {tasks_created}."
        effects += " Проверьте результат перед повтором."
    return f"{notice(code)}{effects}\nЗапрос: {job_id}{run}"


async def recent_errors(db: AsyncSession, item: TelegramIntegration) -> str:
    from zoneinfo import ZoneInfo

    from app.ai.chat_support import owner_timezone
    from app.domains.recurrence import utc
    from sqlalchemy import func, literal, select, union_all

    from .telegram_models import (
        TelegramBusinessMessage,
        TelegramGuestJob,
        TelegramPersonalJob,
    )

    jobs = [
        select(func.coalesce(model.finished_at, model.updated_at).label("at"), literal(label).label("channel"),
               model.error_code.label("code"), model.id.label("reference"))
        .where(model.owner_id == item.owner_id, model.integration_id == item.id, model.deleted_at.is_(None),
               model.error_code.is_not(None), model.error_code != "CANCELLED")
        for model, label in ((TelegramPersonalJob, "Личный AI"), (TelegramGuestJob, "Guest Mode"))
    ]
    business = select(
        TelegramBusinessMessage.updated_at.label("at"), literal("Автоответчик").label("channel"),
        func.coalesce(TelegramBusinessMessage.draft_error_code, "BUSINESS_HANDOFF").label("code"),
        TelegramBusinessMessage.id.label("reference"),
    ).where(
        TelegramBusinessMessage.owner_id == item.owner_id,
        TelegramBusinessMessage.integration_id == item.id,
        TelegramBusinessMessage.deleted_at.is_(None),
        TelegramBusinessMessage.draft_status.in_(("failed", "handoff", "unknown")),
    )
    entries = union_all(*jobs, business).subquery()
    rows = (await db.execute(select(entries).order_by(entries.c.at.desc(), entries.c.reference).limit(20))).all()
    if not rows:
        return "В журнале Telegram ошибок нет."
    zone = ZoneInfo(owner_timezone(item.timezone))
    lines = ["Последние ошибки Telegram"]
    for at, channel, code, reference in rows:
        code = safe_code(code, "AI_ERROR")
        line = f"{utc(at).astimezone(zone):%d.%m %H:%M} · {channel} · {code}\n{_NOTICES[code]}\nID: {reference}"
        if len("\n\n".join(lines)) + len(line) > 3750:
            lines.append("Показаны самые свежие записи.")
            break
        lines.append(line)
    return "\n\n".join(lines)
