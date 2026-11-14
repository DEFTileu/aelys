"""Explicit commands for the verified owner; free text is queued by ingestion."""
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from app.ai.errors import PolicyDenied
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.core.models import TaskReminder
from app.domains import capture
from app.domains.briefings import build_agenda, format_agenda
from app.domains.recurrence import utc
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .telegram_models import TelegramIntegration

HELP = '/task <заголовок>\\n<описание>\n/note <заголовок>\\n<текст>\n/today\n/remind 18:00 <текст>\n/busy 18:00 <статус>\n/free\n/new\n/remember <факт>\n/forget <ID или текст>\n/memory\n/task_suggestions [status|on <chat_id>|off]\n/help'
REMIND_HELP = 'Пример: /remind 18:00 Позвонить, /remind 2026-11-05 18:00 Встреча или /remind 2h Проверить. Укажите будущее время и текст до 300 символов.'
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


async def handle_owner_message(db: AsyncSession, item: TelegramIntegration, text: str, at: datetime, *, source_message_id: str | None = None) -> str | None:
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
        if db.get_bind().dialect.name == 'sqlite':
            connection = await db.connection()
            # Legacy sqlite transaction control does not BEGIN for SELECT.
            # A first SAVEPOINT would therefore commit on RELEASE. Establish
            # the physical caller transaction before creating the savepoint.
            def begin_sqlite(sync) -> None:
                driver = sync.connection.driver_connection
                if driver is None:
                    raise RuntimeError('SQLite connection unavailable')
                if not driver.in_transaction:
                    sync.exec_driver_sql('BEGIN')
            await connection.run_sync(begin_sqlite)
        async with db.begin_nested():
            if command in {'/remember', '/forget', '/memory'}:
                from app.ai.memory import forget, list_memory, remember
                if command == '/remember':
                    if not body or len(body) > 2000:
                        return 'Укажи факт от 1 до 2000 символов: /remember Предпочитаю короткие ответы'
                    fact = await remember(db, item.owner_id, body, source='telegram', source_message_id=source_message_id)
                    return f'Запомнил. ID: {fact.id}'
                if command == '/forget':
                    if not body or len(body) > 2000:
                        return 'Укажи ID или точный текст факта: /forget <ID или текст>'
                    from uuid import UUID
                    try:
                        fact_id = str(UUID(body))
                    except ValueError:
                        fact_id = None
                    fact = await forget(db, item.owner_id, fact_id=fact_id, text=None if fact_id else body)
                    return 'Факт забыт.' if fact else 'Факт не найден.'
                facts = await list_memory(db, item.owner_id, at=at, limit=100)
                if not facts:
                    return 'В памяти пока нет фактов.'
                lines = ['Память владельца:']
                for fact in facts:
                    line = f'{fact.id} · {fact.kind} · {fact.text}'
                    if len('\n'.join(lines)) + len(line) > 3900:
                        lines.append('Полный список и правка доступны в Settings → Memory.')
                        break
                    lines.append(line)
                return '\n'.join(lines)
            if command == '/new':
                from app.core.models import AIConversation
                authorize(item, 'ai.personal.write')
                conversation = AIConversation(owner_id=item.owner_id, title='Telegram assistant')
                db.add(conversation)
                await db.flush()
                item.personal_conversation_id = conversation.id
                item.version += 1
                return 'Новая беседа начата.'
            if command == '/task_suggestions':
                from .telegram_task_controls import handle_task_suggestions
                return await handle_task_suggestions(db, item, body, at)
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
            if command == '/remind':
                try:
                    due, title = parse_remind(body, ZoneInfo(item.timezone), at)
                except ValueError:
                    return REMIND_HELP
                authorize(item, 'tasks.write')
                authorize(item, 'reminders.write')
                task = await capture.create_task(db, item.owner_id, title=title, due_at=due, due_timezone=item.timezone)
                db.add(TaskReminder(owner_id=item.owner_id, task_id=task.id, notify_at=due,
                                    channel='telegram', idempotency_key=f'command:{task.id}'))
                await db.flush()
                return f'Напоминание создано: {title}\n{due.astimezone(ZoneInfo(item.timezone)):%Y-%m-%d %H:%M} {item.timezone}'
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


def parse_remind(body: str, tz: ZoneInfo, at: datetime) -> tuple[datetime, str]:
    instant = utc(at)
    absolute = re.fullmatch(r'(\d{4}-\d{2}-\d{2}) ([0-2]\d:[0-5]\d)\s+(.+)', body, re.DOTALL)
    relative = re.fullmatch(r'(\d+)([mh])\s+(.+)', body, re.DOTALL)
    clock = re.fullmatch(r'([0-2]\d:[0-5]\d)\s+(.+)', body, re.DOTALL)
    if relative:
        amount = int(relative[1])
        if not 1 <= amount <= 525600:
            raise ValueError('Relative time out of range')
        due = instant + timedelta(minutes=amount if relative[2] == 'm' else amount*60)
        title = relative[3].strip()
    elif absolute or clock:
        match = absolute or clock
        assert match is not None
        value = match[2] if absolute else match[1]
        hour, minute = map(int, value.split(':'))
        if hour > 23:
            raise ValueError('Invalid clock')
        local = instant.astimezone(tz)
        first_day = datetime.fromisoformat(absolute[1]).date() if absolute else local.date()
        title = (match[3] if absolute else match[2]).strip()
        candidates = []
        for offset in range(1 if absolute else 3):
            wall = datetime.combine(first_day + timedelta(days=offset), datetime.min.time()).replace(hour=hour, minute=minute)
            for fold in (0, 1):
                candidate = wall.replace(tzinfo=tz, fold=fold).astimezone(UTC)
                if candidate > instant and candidate.astimezone(tz).replace(tzinfo=None) == wall:
                    candidates.append(candidate)
        if not candidates:
            raise ValueError('Past or nonexistent local time')
        due = min(candidates)
    else:
        raise ValueError('Unsupported reminder time')
    if not 1 <= len(title) <= 300:
        raise ValueError('Invalid reminder title')
    return due, title
