# Aelys harness — один полезный срез после ревью

Статус: **PROPOSED / НЕ РЕАЛИЗОВАНО**, редакция 3, 2026-11-13.
[Исследование](../../research/2026-11-13-aelys-personal-harness.md) и
[короткий план](../plans/2026-11-13-aelys-personal-harness.md).
Работа остаётся планированием расширения Phase 4 / task 3; новые grants не выданы.

## Сценарий, trigger и подтверждение

Владелец в личке бота вызывает `/task_suggestions`: бот показывает известные
разрешённые Business-чаты с ID и текущую настройку. `/task_suggestions on <chat_id>`
включает **один** проверенный чат с текущего момента; `off` выключает. Команды
принимаются только от уже привязанного owner в его private bot chat.
Новая реплика контакта сохраняется с task_suggestion_state=queued на самой
TelegramBusinessMessage; отдельный worker анализирует её после ingestion commit.
Секретарь выделяет ноль или одно предложение задачи. При кандидате бот присылает
в личку владельца название, срок/таймзону (либо «не указан») и чат-источник,
с кнопками **«Создать задачу» / «Отклонить»**. Подтверждение выполняется там же;
переход в Web не нужен. В v1 есть только on/off/статус, без pending-команды.
Если уведомление потерялось, неполученное предложение истекает по TTL.

Никакой `/task-proposal` REST endpoint без вызывающего клиента, reply-команды
для каждой задачи или нового экрана. Существующие `/task` и личный AI-диалог
продолжают создавать задачи по действующим правам без лишнего approval.
Suggestions не зависят от переключателя `auto_reply`: opt-in разрешает отдельный
ограниченный анализ, но не отправку ответа контакту и не создание задачи.
Это предложенный UX для утверждения перед реализацией, не уже включённый режим.

## Переиспользование кода

- `approve_action` / `reject_action` выносятся из `ai/api.py` в общий сервис для
  **всех** существующих write tools. `PermissionContext`, `CreateTaskToolArgs`,
  `_action_out`, статусы и `AIAction.result_json` остаются. Новые DTO не нужны.
- У Web approve уже есть CAS pending → approved и commit вместе с domain result.
  Это сохранить и проверить regression, а не обещать построить заново.
- Receipt этого среза — сам `AIAction`: status + `result_json` с kind/id либо
  error; отдельной receipt-таблицы/automation receipt и payload digest нет.
  Аргументы серверные, после preview не редактируются. Любая будущая правка
  создаёт новое предложение; она не подменяет существующий pending payload.
- В AIAction нужны **три** nullable-поля: `source_kind`, `source_id`,
  `expires_at`. Legacy Web actions имеют NULL source.
  Proposed TTL — 24 часа, не позднее source retention; это default для утверждения.
- Новой ревизии источника нет: запомнить edited_at до модели; после неё взять
  исходную inbound-строку FOR UPDATE, проверить тот же edited_at и отсутствие
  deleted_at. Изменения draft/send не считают remote content edit. При approve
  повторно проверить live source/права; source_id разрешается только сервером.

## Доставка и безопасность

Одна nullable-колонка task_suggestion_state на TelegramBusinessMessage:
NULL → queued → generating → ready → sending → sent; no-candidate/skipped_limit/
failed/unknown — terminal. Существующая message row даёт durable trigger;
claim — UPDATE WHERE state='queued' RETURNING id. Никаких строк kind=task_suggestion
в TelegramBusinessCommand, фильтров в command_iteration или разделяемого recovery.
Зависший generating после restart становится failed, sending — unknown, без
автоматической новой генерации/отправки. No-candidate не анализируется снова.
Создание AIAction и state=ready — один commit. CAS ready→sending сохраняется до
private I/O; ошибка доставки не откатывает proposal и не запускает task mutation.

Предлагаемый лимит v1: 20 model attempts на integration за UTC-день и существующий
monthly BYOK budget. Попытка записывается в AIRun с feature marker до I/O под
integration lock, включая неудачные вызовы; RAM-счётчик не подходит. На лимите
сообщение получает skipped_limit, не переносится в завтрашний backlog. Остаток
показывает status-команда; новая модель/дешёвый routing для этого не добавляются.

Edit/delete/clear_messages/purge/retention/off атомарно инвалидируют связанные
AIAction со status=pending (failed, ACTION_SOURCE_STALE) и незавершённый suggestion
state. Такой UPDATE добавляется рядом с существующими eager stale/wipe путями,
а не через изменение command worker. Выполненная задача не удаляется.
Во всех конкурирующих путях порядок lock одинаковый: integration → source →
action. После LLM I/O source проверяется и action вставляется в одной короткой
транзакции; approve держит эти locks до task+result commit. Поэтому edit/delete
либо делает pending stale первым, либо идёт после уже завершённого approve;
не держать DB locks во время model или Telegram network I/O.

`callback_query` пока не запрашивается и не обрабатывается; это новая работа.
В callback передаётся только action ID и approve/reject (до 64 байт), не args/scopes.
Проверить owner sender, private chat, bot identity и источник действия; затем
общий сервис проверяет pending/expiry/live source/current policy и вызывает registry.
Результат задачи и sync сохраняются существующей транзакцией; answerCallbackQuery
и изменение кнопок идут после commit. Повтор callback не повторяет mutation.

Контакт/цитата не получает `tasks.write`. Extractor имеет tools=(), strict
CreateTaskToolArgs либо null, без личной памяти/базы и без выдуманного срока.
Относительные даты считаются от source.sent_at в owner timezone, не от времени
позднего запуска worker. Неоднозначную дату оставлять пустой.
До модели/preview/approve проверяются source и включённый чат. Edit/delete/revoke/off
делают pending stale; уже созданная задача не удаляется вместе с источником.
В action/уведомлении нет копии полной переписки. Существующие encryption,
rotation и retention новых connector-полей сохраняются.

Отдельный ближайший bugfix: durable outbox для `automation/hooks.py` — сейчас
после commit событие живёт только в RAM. Это не часть данной feature и не
основание строить общий workflow engine. Унификация context, summaries, SDK,
новые инструменты и автоматическое создание без подтверждения — за границами.
