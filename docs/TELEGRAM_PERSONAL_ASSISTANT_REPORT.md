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
  Терминальное решение не содержит customer text и не отправляется автоматически;
  ручной ответ владельца и повторная генерация разрешены.
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
| 9 | Ручной ответ во время delay/генерации | `test_manual_owner_answer_suppresses_auto_reply` (2 варианта): во время генерации owner reply доступен только через `get_updates` быстрого poll после LLM; прямого ingest из generate нет. В delay-варианте время продвигается за окно ожидания |
| 10 | Новое входящее во время генерации | `test_new_message_during_generation_suppresses_stale_reply`: новое сообщение приходит через быстрый poll после LLM, старый ответ подавлен, следующая итерация отвечает на новое |
| 11 | No_reply молчит, handoff owner-only, Notification без текста | `test_terminal_decisions_allow_only_explicit_owner_reply`, `test_handoff_notification_survives_private_send_failure`, `test_handoff_edit_keeps_single_notification` |
| 12 | Невалидный JSON/terminal с customer text не доставляются | `test_telegram_ai.py::test_strict_decision_rejects_invalid_and_cross_audience_text`; `test_auto_reply_uses_real_ai_harness_and_records_usage` — 10 вариантов ответа через настоящий harness, mock только HTTP provider/Telegram |
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
4. Проверяет handoff: собеседнику ничего не отправлено, owner DM + Notification;
   после handoff/no_reply можно отправить собственный ручной ответ.
5. Проверяет реальную модель через своего провайдера: JSON разбирается и даёт
   ожидаемое решение. Реальный провайдер в автоматических тестах не вызывался.
6. Сам отключает Business-бота MySDU на этом аккаунте при переключении.
   Учебный MySDU bot и Sheets monitor остаются в MySDU.

Без настоящего токена/подключения эти проверки не считаются выполненными.
Вне среза остаются voice/media/PDF, attachments, memory/RAG, Google Calendar/MCP,
/remind и Telegram reminder delivery, task matrix, shortlist/rolling summary,
любые изменения/импорт MySDU. Никаких новых scope-решений для них не принято.

Коммиты реализации:

- `4702b40` — `refactor(capture): share owner-scoped task and note creation`.
- `57092c5` — `feat(telegram): add personal commands and deferred business decisions`.

Документация/ADR и этот отчёт идут отдельным атомарным docs-коммитом.


## Доработка того же Phase 3 среза после ревью — 2026-11-01

Новые функции, миграция и изменения MySDU не требуются. Исправлены быстрый poll
после генерации, учёт нетекстовых ответов владельца, одна внешняя JSON-обёртка,
ручной ответ/повторная генерация после no_reply/handoff. Sync-пробел не изменён.
Для занятого/потерянного lease внутренний poll возвращает None, успешный пустой
poll — 0; публичный sync API сохраняет числовой processed.

Регрессии написаны до исправлений: **19 failed, 65 passed** в двух backend-файлах;
**3 failed, 371 passed** в web. Причины падения: отправленный устаревший ответ,
отсутствие fast poll/owner marker, отказ fenced JSON и ручного override,
скрытая форма и отсутствие подписи пустой owner-строки. После исправлений:
целевые backend **84 passed**, web Telegram settings **14 passed**.
Отдельная доработка: handoff DM начинается с chat_title, лимит 10 самых новых
чатов за итерацию, общий актуальный check до LLM и перед отправкой вместо
дублирующихся SQL-проверок. Удалённое сообщение владельца также подавляет автоответ.
Регрессии этой доработки до исправления: **4 failed, 1 passed, 58 deselected**.
Проверка ошибки poll в одном из нескольких чатов выявила истёкшие ORM-объекты
после rollback: candidates теперь IDs, следующий объект загружается явно.

### Приёмка 13 сценариев доработки

Все имена ниже из `backend/tests`, кроме указанного web-файла.

| № | Сценарий | Доказательство |
|---|---|---|
| 1 | Owner reply только на быстром poll после LLM | `test_manual_owner_answer_suppresses_auto_reply[True]`: get_updates(offset=3, timeout=0), нет send, ready/failed виден |
| 2 | Новое входящее на быстром poll | `test_new_message_during_generation_suppresses_stale_reply`: первая итерация молчит, вторая отвечает на message_id=50 |
| 3 | Ошибка/занятый lease, cursor/receipt не потеряны, worker продолжает | `test_fast_poll_unavailable_never_sends_or_loses_updates` (2); `test_fast_poll_failure_does_not_abort_remaining_chats` |
| 4 | Нетекстовое/пересланное владельцем отменяет ответ | `test_owner_nontext_or_forward_on_fast_poll_suppresses_reply` (voice, sticker, photo, document, forward), text пуст, caption/file_id/forwarded text отсутствуют в API |
| 5 | sender_business_bot/is_bot не считается владельцем | `test_ignored_echo_or_customer_media_does_not_cancel_reply` (2 echo-варианта) |
| 6 | Нетекстовое клиента игнорируется как раньше | Тот же тест (customer_media): одна inbound запись, ответ на исходное текстовое сообщение |
| 7 | Одна json/безъязыковая обёртка принимается, проза/две отклоняются | `test_single_json_fence_and_empty_owner_history` (2); `test_non_json_wrapper_is_rejected` (4); `test_auto_reply_uses_real_ai_harness_and_records_usage` (10), включая проверку отсутствия отправки при отказе |
| 8 | Ручной текст после handoff/no_reply | `test_terminal_decisions_allow_only_explicit_owner_reply` (2): authenticated POST send, customer получает только Explicit owner response |
| 9 | Automatic никогда не отправляет terminal decision | Тот же тест: две auto-итерации, затем прямой automatic send даёт 409, ручной send проходит |
| 10 | Повтор handoff без дубля Notification/DM | `test_handoff_regeneration_keeps_one_notice_and_owner_dm`: два POST draft с актуальными версиями, одна Notification/DM; edit-вариант сохранён |
| 11 | Chat title + owner note только в личке | `test_handoff_dm_starts_with_chat_title_without_notification_content`: точный текст DM и отсутствие названия/содержимого переписки в Notification |
| 12 | Не больше 10 чатов, новые первыми | `test_auto_reply_limits_twelve_chats_to_ten_newest`: 12 новых чатов, по две реплики, плюс исходный старый чат; ровно 10 вызовов в ожидаемом порядке |
| 13 | Web: пустая форма, отдельная заметка, подпись нетекстового | `apps/web/src/tests/telegram-settings.test.tsx`: handoff/no_reply с отправкой собственного текста и отдельный owner-empty test |

Дополнительно `test_deleted_owner_message_still_suppresses_auto_reply` проверяет
удаление ответа владельца до генерации и его поступление/удаление на быстром poll.
Пустая owner-реплика не входит в AI prompt — проверено в fenced JSON тесте.

### Итоговая валидация после исправлений

Все команды выполнены в этом worktree и собственном .venv. PostgreSQL — новый
локальный disposable `aelys-telegram-review-pg`, loopback 15439; пользовательские
БД/контейнеры не использовались. Значения DB URL/ключей ниже обозначены placeholders.

| Команда | Результат |
|---|---|
| `AELYS_TEST_AI_POSTGRES_ADMIN_URL=<admin> AELYS_TEST_POSTGRES_MIGRATION_URL=<empty-db> make test` | **310 passed, 2 skipped**, 1 Starlette deprecation warning; PostgreSQL AI и migration cases включены |
| `AELYS_DATABASE_URL=<migrated-pg> PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_postgres_integration.py` | **2 passed**, покрывает два пропуска общего прогона |
| `AELYS_TEST_AI_POSTGRES_ADMIN_URL=<admin> PYTHONPATH=backend .venv/bin/pytest -q backend/tests/ai_automation/test_ai_api.py backend/tests/ai_automation/test_ai_event_commit.py` | **8 passed** |
| `PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_telegram_business.py backend/tests/test_telegram_ai.py` | **89 passed** |
| `.venv/bin/ruff check backend/app backend/tests` | passed |
| `.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs` | passed, 72 files |
| `.venv/bin/bandit -q -r backend/app -ll` / `make compile` | passed / passed |
| `.venv/bin/pip-audit` | no known vulnerabilities; local editable package отсутствует в PyPI и пропущен |
| Из backend `PYTHONPATH=. ../.venv/bin/alembic upgrade head`, затем `check` с отдельными SQLite и PostgreSQL URL | passed для обеих БД, no new upgrade operations; head остаётся 0025 |
| `AELYS_SECRET_KEY=<test-key> make openapi`, `git diff --exit-code -- docs/openapi.json` | passed, OpenAPI не изменился |
| `pnpm --filter @aelys/shared typecheck` / `test` | passed / **36 passed**, отдельного build script у shared нет |
| `pnpm --filter @aelys/web typecheck` / `test` / `build` | passed / **374 passed**, 53 files / passed |
| `pnpm --filter @aelys/web exec vitest run src/tests/telegram-settings.test.tsx` | **14 passed** |
| Ruff/mypy для start_local + Ruff scripts/tests, `.venv/bin/pytest -q scripts/tests/test_start_local.py` | passed / **19 passed** |
| `git diff --check` | passed |

pytest также сообщает прежнее предупреждение о неуказанном
asyncio_default_fixture_loop_scope. Предупреждения не исправлялись этой задачей.
Rust/runtime/deployment не менялись; соответствующие platform gates не запускались.
Браузерная приёмка предыдущего среза выше историческая; в этой доработке форма
проверена web-тестами. Живой Telegram и реальная модель через провайдера не
проверялись. Нужен live-check владельца, включая разбираемый JSON, быстрый poll,
нетекстовый ручной ответ и ручной override после handoff/no_reply.

Основные файлы: telegram_service.py (poll/ingest/claims/check/limit/DM),
telegram_ai.py (fence parser), telegram_api.py (числовой processed),
TelegramSettings.tsx (ручная форма и owner-empty label), их регрессии и эти docs.
Первый коммит исправлений: `77fb183` — fix(telegram): refresh updates before automatic replies.
Handoff title, cap и устранение дублирующихся проверок — отдельный следующий коммит.
Миграций нет. MySDU/Sheets, sync и чужие изменения не затронуты. Push/PR не делались.
