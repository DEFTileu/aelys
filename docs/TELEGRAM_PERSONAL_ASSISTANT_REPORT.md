# Phase 3 — личный Telegram и Business-секретарь

Дата: 2026-11-01. Выбран ровно один milestone: Phase 3 task 5,
Telegram commands and verified binding. Ветка `feat/telegram-personal-assistant`,
отдельный managed worktree от `main` (`599c6b3`). Рабочий checkout с Railway/docs
и MySDU не изменялись. Push/PR не выполнялись.

## Результат и границы

Срез реализован и проверен локально; живая доставка Telegram не заявляется.
Один Aelys bot обслуживает личные команды и Business через существующий poller
и AI harness. Он отделён от MySDU bot; Sheets monitor остаётся в MySDU.

- `domains/capture.py`: flush-only создание Task/Note, проверка owner для
  project/parent, первая ревизия Note. Используется рабочими POST `/tasks`,
  `/notes`, AI create_task/create_note и automation create_task.
- `integrations/telegram_personal.py`: `/task`, `/note`, `/today`, `/busy`,
  `/free`, `/help`; только verified owner/private/non-forwarded/non-bot.
  Command mention проверяет bot_username. Свободного personal AI нет.
- `domains/briefings.py`: задачи локального дня, просрочка и события с RRULE/DST;
  terminal statuses взяты из рабочего Tasks client (`done`, `completed`,
  `complete`, `closed`, `cancelled`). Формат включает дату и IANA timezone.
- Сводка выключена по умолчанию; атомарный day claim до отправки. Окно текущего
  локального дня [digest_time, digest_time+2h); после окна нет catch-up.
  Переключение timezone не повторяет уже отмеченный календарный день.
- Секретарь рассматривает только новейшее входящее чата в возрасте от delay
  до delay+300 секунд. Ручной ответ проверяется до LLM и перед отправкой;
  новое входящее во время генерации отменяет устаревшее решение.
- Pydantic разбирает строгий JSON в `BusinessDecision(reply/no_reply/handoff)`.
  Терминальное решение не содержит customer text и не проходит ручной send.
  Handoff создаёт одну content-free Notification и best-effort owner DM.
  Повторный handoff после edit не создаёт вторую Notification/DM.
- `/busy HH:MM <text>` задаёт разрешённый к раскрытию статус с TTL; `/free`
  очищает. Время выбирается как следующее реальное wall-clock наступление,
  включая пропущенные/повторённые часы DST. Истёкший статус не включается в prompt.
- Миграция `0025_telegram_personal` после фактического `0024_device_pairing`:
  timezone, digest_time, last_digest_on, reply_delay_seconds, status_text,
  status_until и owner_note. Последние текстовые поля EncryptedText; rotation
  обновлена и проверена. owner_note очищается с текстом сообщения.
- Owner settings API, shared TS types/client, существующий TelegramSettings
  и OpenAPI обновлены. Использованы существующие контролы, CSS/дизайн не менялись.

`domains/productivity.py` не смонтирован и не изменялся. Рабочие REST —
`domains/api.py`, модели — `core/models.py`. Прочие пути записи не переводились
на capture. CAS, lease, can_reply, окно 24h, budget, rate limit и unknown-delivery
сохранены. Устаревшие генерации сохраняют usage audit, не доставляют старый ответ.

Shortcut доставки: создание объекта + receipt/cursor коммитятся до подтверждения.
Неудавшаяся квитанция не откатывает запись и не повторяется. Digest также не
повторяется после day claim. Потеря подтверждения допустима; дубли недопустимы.
Handoff Notification не теряется при отказе DM. Исключения логируются без
credential URL, provider description и текста переписки.

## Доказательства 15 обязательных сценариев

Пути тестов ниже относительно `backend/tests`.

| № | Проверяемый сценарий | Проверка |
|---|---|---|
| 1 | Чужой ID, group, bot, forward молчат | `test_telegram_personal.py::test_untrusted_messages_are_silent` (6 вариантов) |
| 2 | Повтор update, durable receipt и commit до DM | `test_capture_commits_before_confirmation_replay_and_revision`: отдельная DB session в send видит receipt и GET видит Task; повтор poll не пишет/не отправляет |
| 3 | Потеря квитанции сохраняет Task и polling | `test_confirmation_failure_keeps_write_and_polling_alive`: transport timeout, следующий update обработан, повтор poll пуст |
| 4 | Policy deny/длинный title продвигают cursor | `test_expected_failures_advance_cursor_and_use_savepoint`; `test_failed_partial_capture_savepoint_does_not_block_following_update` откатывает уже flush-нутую частичную запись и обрабатывает следующий note |
| 5 | Task через GET, note revision 1, AI revision 1 | `test_capture_commits_before_confirmation_replay_and_revision`; `test_capture.py::test_ai_note_has_initial_revision` |
| 6 | Local day/DST/RRULE, исключение deleted/terminal | `test_briefings.py::test_agenda_day_bounds_completed_deleted_and_rrule` (3 зоны/даты), `test_today_uses_configured_timezone_and_read_policy` |
| 7 | Digest одна/день, durable claim, disabled/outside молчат | `test_digest_once_persisted_window_disabled_and_failure`; `test_digest_claim_survives_failed_delivery_and_concurrent_workers` — конкурентные отдельные sessions, повторные итерации и потерянная доставка |
| 8 | Задержка и только последнее из серии, один LLM | `test_telegram_business.py::test_reply_delay_latest_series_and_owner_suppression` |
| 9 | Ручной ответ во время delay/генерации | `test_manual_owner_answer_suppresses_auto_reply` (2 варианта); в delay-варианте затем продвигается время за окно ожидания |
| 10 | Новое входящее во время генерации | `test_new_message_during_generation_suppresses_stale_reply` |
| 11 | No_reply молчит, handoff owner-only, Notification без текста | `test_terminal_decisions_cannot_send_owner_note`, `test_handoff_notification_survives_private_send_failure`, `test_handoff_edit_keeps_single_notification` |
| 12 | Невалидный JSON/terminal с customer text не доставляются | `test_telegram_ai.py::test_strict_decision_rejects_invalid_and_cross_audience_text`; `test_auto_reply_uses_real_ai_harness_and_records_usage` — 5 ответов через настоящий harness, mock только HTTP provider/Telegram |
| 13 | Customer injection, tools пусты, action валидируется | `test_busy_status_expiry_and_customer_injection_are_data`, invalid action в двух предыдущих тестах; исходные context isolation tests сохранены |
| 14 | Expired status, /free, /busy следующий день | `test_busy_free_addressed_commands_and_help`; `test_busy_uses_next_real_wall_clock_occurrence_across_dst` (spring gap/autumn fold); `test_busy_status_expiry_and_customer_injection_are_data` |
| 15 | owner_note очищается при edit/delete/retention/clear | `test_owner_note_erased_with_message_content` (4 варианта) |

Дополнительно: исходные concurrent worker, pause, revoked connection, reply window,
rate limiting, ambiguous delivery, encrypted migration/rotation тесты проходят.
Настройки: `test_personal_settings_validation` (6 invalid patches),
`test_personal_settings_roundtrip`; web Telegram settings — 13 тестов.

## Команды и фактические результаты

Зависимости установлены в собственный `.venv` через
`python3 -m venv .venv` и `.venv/bin/pip install -e './backend[test,quality]'`.
`pnpm install --frozen-lockfile` выполнен в worktree. Lockfile не менялся.

| Команда | Результат |
|---|---|
| `make test` с `AELYS_TEST_AI_POSTGRES_ADMIN_URL` и отдельным пустым `AELYS_TEST_POSTGRES_MIGRATION_URL` | **283 passed, 2 skipped**, 1 существующее Starlette deprecation warning; PostgreSQL migration и AI contracts включены |
| `AELYS_DATABASE_URL=<disposable-pg> PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_postgres_integration.py` | **2 passed**, покрывает два PostgreSQL случая, пропущенных в общем прогоне без глобальной DB URL |
| `AELYS_TEST_AI_POSTGRES_ADMIN_URL=<disposable-admin> PYTHONPATH=backend .venv/bin/pytest -q backend/tests/ai_automation/test_ai_api.py backend/tests/ai_automation/test_ai_event_commit.py` | **8 passed**, SQLite + PostgreSQL |
| `.venv/bin/ruff check backend/app backend/tests backend/scripts/rotate_provider_secrets.py` | passed |
| `.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs` | passed, 72 source files |
| `.venv/bin/bandit -q -r backend/app -ll` | passed |
| `make compile` | passed |
| `.venv/bin/pip-audit` | no known vulnerabilities; editable local package не находится в PyPI. Уязвимый pip первоначального venv обновлён до 26.2.2 |
| `PYTHONPATH=. ../.venv/bin/alembic heads`, `upgrade head`, `check` из backend | head 0025; SQLite и отдельный PostgreSQL прошли, no new upgrade operations |
| `AELYS_SECRET_KEY=<local-test-key> make openapi` + сравнение JSON с `app.openapi()` | generated schema matches; новые settings/owner_note присутствуют |
| `pnpm --filter @aelys/shared typecheck` / `test` | passed / **36 passed** |
| `pnpm --filter @aelys/web typecheck` / `test` / `build` | passed / **373 passed** (53 files) / passed |
| `pnpm --filter @aelys/mobile test` | **5 passed** |
| Ruff/mypy для `scripts/start_local.py`, Ruff для `scripts/tests`, `.venv/bin/pytest -q scripts/tests/test_start_local.py` | passed / **19 passed** |
| `PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_telegram_business.py -k manual_owner` (усилена проверка actual delay после полного прогона) | **2 passed, 40 deselected** |
| `git diff --check` | passed |

Для PostgreSQL создан отдельный disposable container `aelys-telegram-personal-pg`
на loopback port 15439. Существующие PostgreSQL-контейнеры не менялись. Runtime/Rust,
signing и production deployment не изменялись; соответствующие platform build
gates не являются проверкой этой backend/web задачи.

## Браузерная приёмка

Реальный Chromium через Playwright CLI, отдельные процессы worktree:
frontend `http://127.0.0.1:5181`, backend `http://127.0.0.1:8011`.
Вход выполнен через одноразовый setup/recovery token в отдельную SQLite DB.
Seed: только синтетический **disabled** connector, без настоящего Telegram token;
worker не обращался к Telegram от его имени.

Через форму сохранены `Europe/Berlin`, `19:30`, `150`. После полной перезагрузки
реальный API и форма вернули те же значения. Mock API/DOM для этой приёмки не
использовался. Тестовые данные не добавлялись в базу владельца.

## Воспроизведение существующего sync-пробела

Автоматическое воспроизведение:

```sh
PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_telegram_personal.py::test_capture_commits_before_confirmation_replay_and_revision
```

1. Owner bootstrap/binding, ingest `/task Title\nDetails` через poll_once.
2. `GET /api/v1/tasks` возвращает созданную Task; `/note` имеет revision 1.
3. `POST /api/v1/devices/enroll` выдаёт device-bound token; с ним создаётся
   ещё одна задача через обычный `POST /api/v1/tasks` для сравнения.
4. `GET /api/v1/sync/pull?cursor=0` с device token возвращает `changes: []`.
5. В коде SyncChange создаётся в `sync/api.py` только при sync push; общий capture
   намеренно этого не исправляет. Pull-only/offline клиенты новые записи не видят,
   пока не загрузят соответствующий REST ресурс. Пробел относится и к REST,
   и к Telegram/AI/automation, а не только к боту.

Следующая предлагаемая цель: единый transactional change-log для рабочих
серверных mutations и их доставка offline-клиентам. Не запускалась автоматически.

## Live-check владельца и отложенное

Перед использованием реальной переписки владелец сам:

1. Настраивает Aelys bot, привязывает свой аккаунт и выдаёт can_reply в Telegram.
2. Проверяет реальный `/task`: задача доступна через Aelys, повтор update не дублирует её.
3. Проверяет Business-переписку с задержкой и отмену автоответа своим сообщением.
4. Проверяет handoff: собеседнику ничего не отправлено, owner DM + Notification.
5. Сам отключает Business-бота MySDU на этом аккаунте при переключении.
   Учебный MySDU bot и Sheets monitor остаются в MySDU.

Без настоящего токена/подключения эти проверки не считаются выполненными.
Вне среза остаются voice/media/PDF, attachments, memory/RAG, Google Calendar/MCP,
/remind и Telegram reminder delivery, task matrix, shortlist/rolling summary,
любые изменения/импорт MySDU. Никаких новых scope-решений для них не принято.

Коммиты реализации:

- `4702b40` — `refactor(capture): share owner-scoped task and note creation`.
- `57092c5` — `feat(telegram): add personal commands and deferred business decisions`.

Документация/ADR и этот отчёт идут отдельным атомарным docs-коммитом.
