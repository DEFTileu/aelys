"""Explicit commands for the verified owner; no personal free-form AI runtime."""
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from app.ai.errors import PolicyDenied
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.domains import capture
from app.domains.briefings import build_agenda, format_agenda
from app.domains.recurrence import utc
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .telegram_models import TelegramIntegration

HELP = '/task <заголовок>\\n<описание>\n/note <заголовок>\\n<текст>\n/today\n/busy 18:00 <статус>\n/free\n/help'
BUSY_HELP = 'Пример: /busy 18:00 занят. Время HH:MM, текст от 1 до 200 символов.'


@dataclass(frozen=True)
class _PolicyDescriptor:
    name: str
    required_scope: str
    external_effect: bool = False


def authorize(item: TelegramIntegration, scope: str, *, external: bool = False) -> None:
    ServerPolicyEngine().authorize(_PolicyDescriptor(scope, scope, external), ToolCall(scope, {}),
                                   PermissionContext(actor=f'telegram:{item.id}', scopes=frozenset({scope}),
                                                     allow_external_effects=external, policy_id='telegram-owner'))


async def handle_owner_message(db: AsyncSession, item: TelegramIntegration, text: str, at: datetime) -> str | None:
    """Caller verifies Telegram identity; isolate expected write errors in a savepoint."""
    # Whitespace can also be a newline immediately after the command.
    parts = text.strip().split(maxsplit=1)
    head = parts[0] if parts else ''
    body = parts[1].strip() if len(parts) > 1 else ''
    command, _, username = head.partition('@')
    if not command.startswith('/'):
        return 'Используйте /help для списка команд.'
    if username and username.casefold() != item.bot_username.casefold():
        return None
    try:
        async with db.begin_nested():
            if command in {'/task', '/note'}:
                if not body or not body.splitlines()[0].strip() or len(body.splitlines()[0]) > 300:
                    return 'Укажите заголовок от 1 до 300 символов, остальное — со следующей строки.'
                title = body.splitlines()[0]
                if command == '/task':
                    authorize(item, 'tasks.write')
                    task = await capture.create_task(db, item.owner_id, title=title,
                                                     description=body.partition('\n')[2])
                    return f'Задача создана: {task.title}\nID: {task.id}'
                authorize(item, 'notes.write')
                note = await capture.create_note(db, item.owner_id, title=title, markdown_body=body)
                return f'Заметка создана: {note.title}\nID: {note.id}'
            if command == '/today':
                authorize(item, 'tasks.read')
                return format_agenda(await build_agenda(db, item.owner_id, ZoneInfo(item.timezone), at))
            if command == '/busy':
                match = re.fullmatch(r'([01]\d|2[0-3]):([0-5]\d)\s+(.+)', body, flags=re.DOTALL)
                if not match or not 1 <= len(match[3].strip()) <= 200:
                    return BUSY_HELP
                authorize(item, 'telegram.status.write')
                tz = ZoneInfo(item.timezone)
                local = utc(at).astimezone(tz)
                # Round-trip each fold: skip nonexistent spring-forward times,
                # and choose the next real instant during a repeated autumn hour.
                candidates = []
                for offset in range(3):
                    wall = (local + timedelta(days=offset)).replace(
                        hour=int(match[1]), minute=int(match[2]), second=0, microsecond=0,
                    )
                    for fold in (0, 1):
                        candidate = wall.replace(fold=fold).astimezone(UTC)
                        if (candidate > utc(at) and candidate.astimezone(tz).replace(tzinfo=None)
                                == wall.replace(tzinfo=None)):
                            candidates.append(candidate)
                until = min(candidates).astimezone(tz)
                item.status_text = match[3].strip()
                item.status_until = until.astimezone(UTC)
                item.version += 1
                return f'Статус установлен до {until:%Y-%m-%d %H:%M} {item.timezone}.'
            if command == '/free':
                authorize(item, 'telegram.status.write')
                item.status_text = None
                item.status_until = None
                item.version += 1
                return 'Статус занятости очищен.'
            return HELP if command == '/help' else 'Используйте /help для списка команд.'
    except PolicyDenied:
        return 'Действие запрещено политикой доступа.'
    except (HTTPException, ValueError):
        return 'Не удалось выполнить команду. Проверьте данные и повторите.'
