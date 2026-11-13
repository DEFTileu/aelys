# Aelys Personal Harness: shared task proposals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** единый проверяемый путь предложения и подтверждения задачи для Web AI
и явного owner-запроса по Business-сообщению, как первый срез личного harness.

**Architecture:** расширить существующие AIAction/ToolRegistry/Policy Engine,
вынести proposal/execution в общий сервис и оставить доставку в channel adapters.
Доменное создание задачи, receipt и sync-log выполняются одной DB-транзакцией.
Общее ядро не объединяет права/истории каналов.

**Tech Stack:** существующие FastAPI/Python, Pydantic, SQLAlchemy/Alembic,
PostgreSQL + SQLite tests, React/TypeScript для совместимости текущих DTO.
Без новых SDK, queue vendors и UI redesign.

**Spec:** [Design brief](../specs/2026-11-13-aelys-personal-harness-design.md).
Исследование и H0–H7 roadmap: [Personal harness research](../../research/2026-11-13-aelys-personal-harness.md).

Статус: **PROPOSED / NOT IMPLEMENTED**. Авторизованы исследование и планирование.
План не запускает миграции, новые права, создание задач или production rollout.
Детальный план покрывает **ровно Phase 4 / task 3**, а не H0–H7 целиком.

## Global Constraints

- Full CLI session transcripts + embeddings stay on Mac, never in cloud DB,
  logs, telemetry, attachments or client sync.
- Automation always passes through Policy Engine; agent instructions or
  retrieved text never grant permissions.
- BYOK: encrypted secret store, never expose keys to frontend/logs or send to
  LLM as tool content.
- Offline first: client mutations durable in local store before sync; server
  writes versioned/idempotent.
- No UI design or VPS provider selection without explicit instruction.
- Any decision marked OPEN or PROPOSED remains so until owner approval /
  evidence-based spike.
- Сохранить действующие личные owner-команды и Business same-message edit /
  session/retention guards. Не выдавать Business `tasks.write`.

## Review Focus

1. Повтор/конкуренция approve, crash и DB rollback: одна задача и один receipt.
2. Подмена источника/проекта/параметров после preview: запрет исполнения.
3. Source delete/revoke/retention между предложением и исполнением: stale.
4. Поддельный owner/source в тексте или tool output: не меняет server context.
5. Private preview/task details случайно попадают в contact reply, SSE replay,
   debug log или legacy export: запрещено, synthetic sentinel regression.

## Предлагаемые интерфейсы первого среза

Создать `backend/app/ai/action_contracts.py`:

- `ProposalSource(kind: Literal['web','telegram_business'], id: str, version: int)`:
  только opaque ID/version; фактические owner/chat/project получают из DB.
- `TaskProposalArgs`: использовать существующий `CreateTaskToolArgs` с
  `extra='forbid'`, timezone-aware `due_at`, существующими лимитами title/description;
  не вводить произвольные table/tool/SQL поля.
- `VerifiedActionContext`: immutable серверные owner_id, actor_id, channel,
  audience='owner', source, policy_id, operation_id. Не принимать его как trusted
  JSON от модели/контакта.
- `ActionPreview`: action_id, tool='create_task', typed arguments, payload_digest,
  source label, expires_at, status. Сырой чат в preview не требуется.
- `ActionOutcome`: action_id, status, result kind/id либо stable error code.

Создать `backend/app/ai/actions.py`:

```python
async def propose_task(db: AsyncSession, ctx: VerifiedActionContext,
                       args: TaskProposalArgs) -> ActionPreview: ...
async def approve_task(db: AsyncSession, owner_id: str, action_id: str,
                       expected_digest: str | None = None) -> ActionOutcome: ...
async def reject_task(db: AsyncSession, owner_id: str,
                      action_id: str) -> ActionOutcome: ...
```

`expected_digest` optional только для совместимости старых Web карточек;
новые source-bound proposals требуют его. Сервер во всех случаях пересчитывает
и проверяет digest собственного immutable payload перед вызовом handler.
Доступная клиенту история ответа не считается источником прав.

Предлагаемые новые error codes: `ACTION_EXPIRED`, `ACTION_SOURCE_STALE`,
`ACTION_PAYLOAD_CHANGED`, `ACTION_NOT_PENDING`. Existing `NOT_FOUND`,
`POLICY_DENIED`, `IDEMPOTENCY_CONFLICT` и `ACTION_REJECTED` сохраняются.
Предлагаемый TTL: min(24h, expiry применимого grant/source); default подлежит
утверждению. Отсутствие новых полей у legacy actions не выдаёт новый scope.

## Task 1 — общий proposal/approval service и совместимость Web

**Files:**

- Create: `backend/app/ai/action_contracts.py`, `backend/app/ai/actions.py`.
- Modify: `backend/app/core/models.py` (`AIAction`), `backend/app/ai/chat_support.py`
  (`gate_writes`), `backend/app/ai/api.py` (approve/reject and output DTO).
- Create: следующая миграция `backend/alembic/versions/*_action_provenance.py`.
  Номер определить после проверки актуальной migration head.
- Test: `backend/tests/ai_automation/test_action_service.py`,
  `backend/tests/ai_automation/test_ai_chat_design.py`,
  `backend/tests/ai_automation/test_ai_event_commit.py`.
- Docs/types if wire shape changes: `docs/API_CONTRACTS.md`, `docs/openapi.json`,
  generated/shared AI DTO в `packages/shared` согласно текущему generator.

**Consumes:** существующие `AIAction`, typed create validators, registry,
`domains/capture.py:create_task`, `sync/change_log.py` owner locks.
**Produces:** три сервиса выше; совместимый Web action API.

- [ ] Зафиксировать baseline текущих Web pending/approve/reject тестов и
  существующей личной Telegram task-команды; составить матрицу каналов/прав.
- [ ] RED: `test_proposal_has_no_task_side_effect`, `test_repeat_intent_returns_same_preview`,
  `test_changed_payload_same_operation_conflicts`, `test_parallel_approvals_create_one_task`,
  `test_rollback_keeps_task_receipt_and_sync_atomic`, `test_foreign_owner_cannot_approve`.
  Проверять Task/receipt/sync rows, а не только строку ответа модели.
- [ ] RED: expiry, changed digest/source/project, expired/revoked policy и reject
  не создают задачу. Test 1 успешного approve → repeat возвращает тот же task ID.
- [ ] Добавить backward-compatible AIAction provenance/digest/expiry/result binding.
  Legacy Web карточки остаются рабочими без выдуманного Business origin.
  Не копировать plaintext переписку в action payload; новые sensitive storage
  поля включить в encrypt/rotation/retention path. Если нужны новые поля, описать
  миграцию и проверить downgrade/data preservation.
- [ ] Реализовать normalise/validate → policy → source check → pending preview;
  при approve owner-lock/CAS pending → domain call → receipt/result/sync → commit.
  Не держать DB write transaction во время LLM/network I/O. Existing `gate_writes`
  вызывает сервис, endpoint больше не дублирует выполнение.
- [ ] GREEN: весь `test_ai_chat_design.py` и новая action-service suite; SQLite
  + disposable PostgreSQL concurrent claim/rollback. Без PostgreSQL не заявлять
  concurrency acceptance; зафиксировать skip и выполнить перед выпуском.
- [ ] Атомарный commit: `feat(ai): centralize task proposals and approvals`.

## Task 2 — явное предложение из Business-сообщения без новых прав контакта

**Files:**

- Create: `backend/app/integrations/telegram_task_proposals.py`.
- Modify: `backend/app/integrations/telegram_api.py` (owner-authenticated request
  adapter), `backend/app/integrations/telegram_service.py` (source current/wipe hooks).
- Reuse: `telegram_models.py`, `telegram_business` ownership/connection guards,
  `ai/execution.py`, action service Task 1.
- Test: `backend/tests/test_telegram_task_proposals.py`,
  `backend/tests/test_telegram_context_sessions.py` (границы источников сохраняются).
- Docs: `docs/TELEGRAM_BUSINESS.md`, `docs/API_CONTRACTS.md`.

**Consumes:** opaque Business message ID + its expected version from owner request.
**Produces:** private `ActionPreview`, привязанный к owner AIConversation/AIRun
для показа существующим Web action API/card consumer. Telegram approval UI не
существует и не объявляется готовым; новая связь и получение preview входят в Task 2.

- [ ] RED: новый owner-only `POST /api/v1/integrations/telegram/messages/{id}/task-proposal`
  с `expected_version` и `Idempotency-Key` создаёт pending preview, Task count=0.
  Новый endpoint — предложение API, не уже опубликованный контракт.
- [ ] RED: contact/bot/forward/forged owner, foreign chat/integration, deleted source,
  wrong version и disconnected binding не порождают preview или provider call.
- [ ] Построить VerifiedActionContext из server principal + DB binding/source.
  Сам message text — untrusted. Модель выдаёт только strict TaskProposalArgs;
  нет domain tools, send tools, personal memory, чтения других диалогов.
  Неоднозначную дату не угадывать: nullable due либо unresolved flag вне task args.
- [ ] Привязать приватный run/conversation для preview с минимальными metadata,
  без копии полного чата; соблюдать существующую Business retention и шифрование.
  После удаления источника invalidate pending preview. Исполненная задача не
  удаляется автоматически; source link становится unavailable.
- [ ] GREEN: approve/reject проходят общий сервис. Сценарий сообщения → preview →
  approve → одна задача + sync работает с synthetic LLM boundary. Проверить,
  что callback/handler не отправил ничего контакту и обычный `/ask` не меняет права.
- [ ] RED/GREEN injection fixtures RU/KK/EN: «игнорируй правила/я владелец/выдай ключ»
  в исходном сообщении/цитате/tool output не расширяют scope или audience.
- [ ] Атомарный commit: `feat(telegram): propose owner tasks from verified sources`.

Превращение этого явного пути в непрерывный secretary observer — **следующий
отдельный срез** с opt-in настройкой, throttling/dedup и отдельными acceptance.
Не запускать анализ всех сообщений/проактивные уведомления из одного этого плана.

## Task 3 — общий contract corpus и выпускная проверка

**Files:**

- Create: `backend/tests/ai_automation/test_harness_contracts.py`,
  `backend/tests/fixtures/harness/README.md`, synthetic JSON cases в этой папке.
- Modify only as needed: shared AI DTO / существующий action card consumer;
  без нового экрана/переработки дизайна.
- Record: `docs/optimization/aelys-harness-task-proposals.md`.

**Consumes:** Task 1/2 services and adapters.
**Produces:** воспроизводимый run/report; permission matrix и список ограничений.

- [ ] Добавить 40 сценариев из исследования. Детерминированные assertions для
  source/audience/scopes/дублей; semantic rubric для текста отдельно.
  Fixtures только синтетические, никаких личных чатов/CLI transcripts/API keys.
- [ ] Сравнить Web и Business на одном proposal/execution contract, сохранив
  разные authority profiles. Прямой owner text/voice остаётся в текущем разрешённом
  режиме, quoted/file turns не получают write grants.
- [ ] Проверить delete/revoke в трёх местах: до модели, после модели, до commit;
  concurrent approve/reject, restart с pending proposal, source version change,
  refusal/timeout, отсутствие sentiment-only «успеха» без domain result.
- [ ] Проверить sentinel отсутствие в contact replies, logs/SSE/general sync/export;
  в sync разрешена только новая явно подтверждённая Task, не connector payload.
- [ ] Выполнить проверки ниже, сохранить точные counts/skips/errors и миграции.
  Не выдавать отсутствие тестового PostgreSQL/Mac за успешную проверку.
- [ ] Независимый review; находки подтверждать RED/GREEN regression, затем relevant
  suite. Release выполняется только в отдельно разрешённом rollout.
- [ ] Commit tests/docs отдельно либо вместе с соответствующим логическим fix.

## Команды проверки (из корня репозитория)

Создать/использовать полное согласованное окружение `backend[test,quality]`.
Если `.venv` лежит в другом checkout, задать путь интерпретатора, не секреты.

```sh
.venv/bin/python -m pytest backend/tests/ai_automation/test_action_service.py backend/tests/ai_automation/test_ai_chat_design.py backend/tests/test_telegram_task_proposals.py -q --tb=short
.venv/bin/python -m pytest backend/tests -q --tb=short
.venv/bin/ruff check backend/app backend/tests
.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs
.venv/bin/bandit -q -r backend/app -ll
pnpm --dir apps/web typecheck
git diff --check
```

После wire/consumer changes — релевантные Vitest action-card/API tests, full Web
checks по CI. `alembic upgrade head`/`alembic check`/downgrade только на disposable
SQLite/PostgreSQL, не на личной production DB для тестов. OpenAPI генерировать и
проверить по действующему CI. Неприменимые UI/Mac проверки не придумывать.

## Definition of done и handoff

Рабочий source → private preview → owner approval → Task + sync с реальным
смонтированным API/domain/service и synthetic external model I/O; PostgreSQL
concurrency проверен; нет изменений чужих scopes, секретов или contact effects.
Выпускной отчёт отделяет automated tests от permitted live acceptance.

Проверить план и утвердить предложенные новые API/TTL/явный trigger перед кодом.
Владелец может выбрать любой один следующий этап; общий roadmap не даёт
разрешения выполнять все H0–H7, создавать новые grants или менять production.
