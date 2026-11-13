# Telegram task suggestions — короткий Implementation Plan v3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax.

**Goal:** секретарь предлагает задачу из одного opt-in Business-чата; владелец
подтверждает inline-кнопкой в личке бота. **Статус: Task 1 реализован и проверен; Task 2 не начат.**
**Architecture:** существующие AIAction, общий generic approve/reject, registry,
отдельное состояние сообщения и capture/sync. **Tech Stack:** текущий FastAPI/Python/PostgreSQL.
**Spec:** [сценарий и точные границы](../specs/2026-11-13-aelys-personal-harness-design.md).
**Roadmap anchor:** предлагаемое расширение Phase 4 / task 3, не rewrite harness.

## Global Constraints

Policy Engine исполняется перед mutation; контактный текст не выдаёт прав.
Личные /task-команды, Web actions и Business /ask/search остаются рабочими.
BYOK secrets и raw CLI transcripts не попадают в prompts/logs/cloud sync.
Нет новых SDK, очередей/vendor, экранов, digest и receipt-таблиц.

## Review Focus

Повтор approve → та же задача; чужой callback → отказ; edit/delete/off/expiry →
stale; injection → никакого нового scope; предложение/результат → только owner.

## Task 1 — выделить существующий action service без нового task-only пути

**Files:** `ai/api.py`, новый `ai/actions.py`, `core/models.py`, следующая
`alembic/versions/*_action_source.py`; tests в `ai_automation/test_ai_chat_design.py`
и новом `test_action_sources.py`. Пути Python относительны `backend/app`.

- [x] Baseline: проверить текущие pending/approve/reject тесты для create_note,
  create_task, complete/update/reminder. Не подменять общий approve на approve_task.
- [x] Перенести тело approve/reject и owner lookup как есть в сервис; endpoints
  делегируют туда. Сохранить CAS, registry/policy, commit и формат _action_out.
- [x] Добавить nullable source_kind/source_id/expires_at в AIAction;
  approve не читает source: только action CAS/status и expires_at; legacy NULL работает.
  ACTION_EXPIRED ставит сервис; ACTION_SOURCE_STALE — инвалидатор в result_json
  при status=failed. ACTION_NOT_PENDING уже есть. TTL новых suggestions: 24 часа.
- [x] Args immutable после preview; approve принимает action ID без клиентского
  payload. Receipt — AIAction.status/result_json, новую таблицу не создавать.
- [x] RED/GREEN: nullable migration compatibility, owner/source/expiry checks,
  repeat approval, failed handler rollback; regression всех старых write tools.
  Отдельно concurrent approve и approve/reject на disposable PostgreSQL.
- [x] Commit: `refactor(ai): share action approval and source checks`.

## Task 2 — замкнуть trigger → proposal → private buttons → task

**Files:** `integrations/telegram_{personal,service,transport,models}.py`, новый
`telegram_task_suggestions.py`, миграция connector-полей; `docs/TELEGRAM_BUSINESS.md`.
Tests: новый `backend/tests/test_telegram_task_suggestions.py`, transport tests.

- [ ] Зафиксировать UX из spec: private `/task_suggestions` (список/статус),
  `on <chat_id>` / `off`; один активный чат, только новые сообщения.
  Новые настройки — nullable chat_id и enabled_at; нет historical backlog scan.
- [ ] Добавить только nullable `TelegramBusinessMessage.task_suggestion_state`;
  ingestion ставит queued для нового подходящего inbound. Новый worker claims
  через UPDATE WHERE state='queued', без увеличения message.version.
  TelegramBusinessCommand и его worker не менять.
  Interrupted generating → failed без автоповтора; no-candidate тоже terminal.
- [ ] Перед моделью сохранить edited_at; после модели взять источник FOR UPDATE
  и сравнить edited_at/deleted_at. Pending-actions инвалидировать при remote edit,
  delete, clear/purge, retention и off. Ни content_version, ни action.source_version.
  Worker/invalidation: integration → source → action. Approve — только CAS action.
- [ ] Extractor использует текущий provider/budget/timeout, tools=(), strict
  CreateTaskToolArgs|null. Проверить source/allowlist до и после модели; неясный
  срок оставить пустым. Создать приватные AIConversation/AIRun и pending AIAction
  с минимальными metadata, без полной копии чата; expires_at = created_at + 24 часа
  (либо раньше, если source retention заканчивается раньше).
- [ ] Лимит v1: 20 попыток модели на integration за UTC-день + текущий monthly
  budget; резервировать попытку durable AIRun до I/O под integration lock,
  учитывать ошибки/рестарты. Лимит исчерпан → skipped_limit, без backlog на завтра.
- [ ] Persist proposal и state=ready до I/O; private sendMessage с кнопками
  «Создать задачу»/«Отклонить». CAS ready→sending до отправки, затем sent/unknown;
  неизвестная отправка не повторяется. Без pending-команды: предложение истечёт по TTL.
- [ ] Добавить callback_query в allowed_updates, безопасный parser,
  answerCallbackQuery и private editMessageReplyMarkup для закрытия кнопок; callback data = operation + opaque action ID (<=64 bytes).
  Проверить bound owner, private chat и bot identity; args/permissions только из DB.
- [ ] Callback вызывает общий service Task 1; commit результата до answer/edit
  клавиатуры. Успех показывает task ID; stale/expiry/reject — понятный terminal ответ.
  Контакту ничего не отправлять. Удаление source/revoke/off инвалидирует pending.
- [ ] RED/GREEN: 10 кейсов ниже, source/key rotation/retention и миграция; обновить
  документацию. Не добавлять общий framework/corpus ради этого среза.
- [ ] Commit: `feat(telegram): suggest tasks with private owner approval`.

## 10 детерминированных кейсов, внутри Task 1/2

1. Opt-in одного известного чата → кандидат → private preview, Tasks count=0.
2. Approve → одна Task + result_json + sync; повтор/конкуренция не дублируют.
3. Reject и approve/reject race не создают задачу после подтверждённого reject.
4. Off/чужой чат/старое сообщение/no-candidate не создают preview; /task не меняется.
5. Source edit/delete/revoke между extraction/preview/approve → отказ, не stale task.
6. Чужой sender/group/forged callback или source ID → нет provider/mutation.
7. Expiry/недоступный проект/policy denial → нет записи, legacy Web approvals работают.
8. Injection в RU/KK/EN не выдаёт tools/scopes и не публикует private данные контакту.
9. Restart/replayed update не дублирует analysis/action; unknown private send не replay.
10. Suggestion-state не меняет message.version и не ломает draft CAS; неясный срок не угадывается; дневной лимит
    (включая concurrent workers и restart) не превышается; cleanup покрывает новое state.

Run relevant pytest, full backend, Ruff/mypy/Bandit и migration checks; точные
команды взять из действующего CI. PostgreSQL race обязателен до выпуска, skip не
считать acceptance. Реальный Telegram smoke — только с разрешённым чатом владельца.
UI design, автоматическое создание без approve и production rollout не разрешены
одним этим документом. Task 3 и несвязанные continuity/retrieval fixtures удалены.
