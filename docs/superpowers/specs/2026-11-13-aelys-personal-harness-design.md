# Aelys harness — один полезный срез после ревью

Статус: **PROPOSED / НЕ РЕАЛИЗОВАНО**, редакция 2, 2026-11-13.
[Исследование](../../research/2026-11-13-aelys-personal-harness.md) и
[короткий план](../plans/2026-11-13-aelys-personal-harness.md).
Работа остаётся планированием расширения Phase 4 / task 3; новые grants не выданы.

## Сценарий, trigger и подтверждение

Владелец в личке бота вызывает `/task_suggestions`: бот показывает известные
разрешённые Business-чаты с ID и текущую настройку. `/task_suggestions on <chat_id>`
включает **один** проверенный чат с текущего момента; `off` выключает. Команды
принимаются только от уже привязанного owner в его private bot chat.
Новая реплика контакта в выбранном чате попадает в durable connector queue.
Секретарь выделяет ноль или одно предложение задачи. При кандидате бот присылает
в личку владельца название, срок/таймзону (либо «не указан») и чат-источник,
с кнопками **«Создать задачу» / «Отклонить»**. Подтверждение выполняется там же;
переход в Web не нужен. `/task_suggestions pending` повторно показывает pending
предложения по явному запросу, если уведомление потерялось.

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
- В AIAction нужны **четыре** nullable-поля: `source_kind`, `source_id`,
  `source_version`, `expires_at`. Legacy Web actions имеют NULL source.
  Proposed TTL — 24 часа, не позднее source retention; это default для утверждения.
- Source version должна означать изменение содержимого, а не draft/send state.
  В Business `Owned.version` меняется и worker-ом: для нового пути добавить
  `content_version` (default 1), увеличивать при remote content edit/delete.
  Связь source_id → owner/integration/connection/chat проверяется сервером.

## Доставка и безопасность

Queue опирается на существующий `TelegramBusinessCommand`, новый kind
`task_suggestion` без session/answer; selector owner `/ask`-worker его исключает.
Кандидат AIAction и смена queue state сохраняются до отправки preview. Queue
claim/state также фиксирует попытку уведомления; ambiguous send — unknown без
автоматического повтора. Нулевой кандидат тоже terminal, чтобы не читать его снова.

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
