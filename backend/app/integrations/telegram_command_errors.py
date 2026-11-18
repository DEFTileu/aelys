"""Allowlisted owner diagnostics: never expose exception text or provider bodies."""
from app.ai.errors import AIError
from fastapi import HTTPException

from .telegram_transport import TelegramError

_NOTICES = {
    "COMMAND_EMPTY": "Добавьте вопрос после /ask или /search либо ответьте командой на сообщение/выделенную цитату.",
    "SEARCH_UNAVAILABLE": "Веб-поиск не дал подтверждённых источников. Ответ в чат не отправлен; попробуйте другой запрос или /ask.",
    "COMMAND_CONTEXT_CHANGED": "Ответ опубликован, но его источник изменился во время публикации. Он исключён из контекста; проверьте переписку.",
    "COMMAND_TOO_LONG": "Вопрос и ответ не помещаются в одно сообщение. Сократите команду и попробуйте снова; исходный текст сохранён.",
    "COMMAND_STALE": "Команда или подключение изменились. Ответ в чат не отправлен.",
    "COMMAND_INTERRUPTED": "Выполнение команды прервано. Проверьте переписку перед новой командой; автоматического повтора нет.",
    "TELEGRAM_DELIVERY_UNKNOWN": "Результат отправки ответа неизвестен. Проверьте переписку перед новой командой; автоматического повтора нет.",
    "PROVIDER_REQUIRED": "AI-провайдер не настроен или отключён. Выберите активного провайдера с сохранённым ключом в настройках Telegram.",
    "PROVIDER_ERROR": "AI-провайдер вернул ошибку. Проверьте его доступность, API-ключ и баланс; затем повторите команду.",
    "MODEL_UNAVAILABLE": "Выбранная модель AI недоступна. Выберите другую модель в настройках Telegram.",
    "BUDGET_EXCEEDED": "Недостаточен бюджет AI для этой команды. Проверьте месячный лимит расходов провайдера.",
    "POLICY_DENIED": "Политика доступа запрещает выполнение команды или передачу данных AI. Проверьте разрешения интеграции.",
    "AI_UNAVAILABLE": "AI вернул пустой или неподдерживаемый ответ. Повторите запрос или выберите другую модель.",
    "AI_ERROR": "Не удалось получить ответ AI. Повторите запрос; при повторном сбое передайте код и номер команды разработчику.",
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


def error_code(exc: Exception) -> str:
    candidate = None
    if isinstance(exc, HTTPException) and isinstance(exc.detail, dict):
        candidate = exc.detail.get("code")
    elif isinstance(exc, AIError):
        candidate = exc.code
    elif isinstance(exc, TelegramError):
        from .telegram_service import remote_code
        candidate = remote_code(exc)
    return candidate if isinstance(candidate, str) and candidate in _NOTICES else "COMMAND_FAILED"


def notice(code: str, command_id: str | None = None) -> str:
    safe_code = code if isinstance(code, str) and code in _NOTICES else "COMMAND_FAILED"
    reference = f"\nКоманда: {command_id}" if command_id else ""
    return f"{_NOTICES[safe_code]}\nКод: {safe_code}{reference}"
