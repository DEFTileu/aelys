# H5: надёжная доставка событий автоматизации — план

> Исполнение: `superpowers:executing-plans` или `superpowers:subagent-driven-development`; этот документ не разрешает деплой.

**Цель:** транзакционный outbox Phase 7 с доставкой через `dispatch_event` и существующей дедупликацией `_claim_execution`.
**Основание:** `docs/ARCHITECTURE.md` §3, `docs/IMPLEMENTATION_PLAN.md` Phase 7, уточнения владельца H5.
**Стек:** FastAPI, SQLAlchemy AsyncSession, Alembic, PostgreSQL, SQLite, pytest; новых зависимостей нет.
**Границы:** Policy Engine и POST `/automations/dispatch` сохраняют поведение; Business, Telegram-бота, H3 и OPEN-решения не менять. Production-миграция и деплой только с разрешения.

## Факты и ограничения

- `record_domain_change` вызывает синхронный `enqueue` после flush: `db.add()` допустим; следующий flush/commit включит строку в транзакцию. Проверить повторный enqueue и вложенные savepoint/rollback.
- Guard `_running_automation` проверять до `db.add`, устанавливать и сбрасывать вокруг каждой доставки; существующий API guard сохранить.
- `_claim_execution` делает flush, не commit: при аварии до commit транзакция должна откатить claim и действия; проверить PostgreSQL и SQLite/savepoint. Уже закоммиченный `running` остаётся duplicate и автоматически не восстанавливается.
- В outbox-режиме сохранённый `failed` — конечный результат конкретного правила: перейти к следующему правилу; при повторной доставке не переисполнять и failed, и completed. `rate_limited` — доставлено. Для обычного POST сохранить прежние исключения и повтор failed.
- Сбой без достоверно записанного результата правила требует повтора события; частично обработанные правила повторно не исполняются. Пустой набор правил тоже означает успешную доставку; `AutomationExecution` при этом может отсутствовать.
- PROPOSED: задержки после начатых попыток 30 с, 2 мин, 10 мин, затем 1 час; новые попытки только пока возраст события меньше 24 часов. После этого warning без payload, строка сохраняется; ручной инструмент не создавать. Безусловная доставка при длительном сбое не гарантируется.
- В `main.py` нет общего нейтрального цикла: отдельная lifespan-задача outbox, без изменений Telegram/Business. Непопавшие в outbox старые события не восстановить.
- `attempts` ограждает завершение: удаление и перенос повтора допустимы только при совпадении номера попытки; дедупликация действий остаётся на уровне транзакций правил. Lease не добавлять.

## Файлы и коммиты

- Первый коммит: `backend/app/core/models.py`, миграция `backend/alembic/versions/0057_automation_event_id.py`, PostgreSQL-тест `backend/tests/ai_automation/test_automation_outbox_database.py`: расширение `automation_executions.event_id` с 36 до 100.
- Следующий коммит: новая миграция `backend/alembic/versions/0058_automation_outbox.py` добавляет таблицу outbox; `backend/app/automation/hooks.py`, `backend/app/automation/api.py`, `backend/app/main.py`, `backend/tests/test_automation_hooks.py`, `backend/tests/test_automation_outbox.py`, PostgreSQL/SQLite-тесты. Итого две независимые последовательные миграции; проверить актуальный Alembic head.
- Первая миграция пригодна к отдельному деплою; вторая ссылается на первую. Downgrade сужения запрещён, если сохранённые ID длиннее 36.

## Порядок работы: тесты сначала красные

- [ ] На disposable PostgreSQL создать тест вставки реального `task.created:<uuid>` в `automation_executions.event_id`: до миграции запустить и зафиксировать фактический результат; после расширения до 100 тест должен пройти. Подтвердить или опровергнуть падение именно по фактическому запуску, не считать SQLite доказательством. Первый коммит также обновляет проверки Alembic head для самостоятельного прохождения набора.
- [ ] Написать красные тесты: commit без немедленной доставки → recovery доставляет; rollback → строки нет; запись автоматизации → новых событий нет; повторный enqueue и nested commit/rollback сохраняют только корректные события и не запускают доставку до внешнего commit.
- [ ] Добавить outbox: PK, `owner_id`, `kind`, `event_id`, JSON `payload`, `created_at`, `available_at`, `attempts`; unique `(owner_id, kind, event_id)`, индекс выборки, FK владельца. Запись в транзакции domain write; после внешнего commit сигнал, чтение только из БД; при отсутствии event loop восстановит worker.
- [ ] Написать красный тест трёх подходящих правил: второе всегда падает и имеет durable `failed`, первое и третье выполнены по разу, строка удалена. Добавить явный outbox-режим `dispatch_event`: продолжать после подтверждённого commit failed, пропускать ранее записанный failed при повторе; не подавлять ошибки до записи результата и не менять поведение POST и Policy Engine.
- [ ] Проверить crash после failed второго правила до третьего: повтор доводит третье до результата, первые два не исполняет снова. Проверить сбой до записи результата и неопределённый исход commit: не удалять outbox до подтверждённого результата, повторить; тестировать и частичные успехи нескольких правил.
- [ ] Добавить красные тесты: ошибка без результата → попытки по заданной последовательности, граница 24 часов, warning без payload, строка остаётся; crash после claim, restart, отсутствие блокировки остальных событий. Тесты используют управляемое время, без sleep.
- [ ] Claim: условный атомарный UPDATE по `id`, наблюдаемому `attempts`, `available_at <= now` и возрасту <24 ч; увеличить attempts и перед dispatch назначить следующую `available_at`; короткую транзакцию завершить до отдельной сессии dispatch. Удалять по id и номеру попытки только после успешной обработки всех правил; при ошибке обновлять срок по id и номеру попытки.
- [ ] Тестировать два независимых конкурентных worker и повторную доставку: действия правила выполнены один раз; отдельно проверить долгую попытку, перекрытие следующей и ошибку одной из них, проверить защиту по attempts при изменении правил между попытками. SQLite `BEGIN IMMEDIATE`, PostgreSQL блокировки и транзакции проверить на реальных соединениях; SQLite write lock outbox во время dispatch не удерживать.
- [ ] Worker запускать при старте и периодически (PROPOSED polling 30 с), выбирать eligible строки в порядке `(created_at, id)` ограниченными batch; сигнал commit ускоряет первую доставку. Изолировать ошибки событий и завершать задачу при shutdown.
- [ ] Выполнить `cd backend && ../.venv/bin/pytest tests/test_automation_hooks.py tests/test_automation_outbox.py tests/test_automation_api.py tests/ai_automation/test_automation_outbox_database.py -q` и `../.venv/bin/ruff check app/automation app/core/models.py app/main.py tests/test_automation_outbox.py tests/ai_automation/test_automation_outbox_database.py`. Проверить upgrade/downgrade новой миграции на временных БД; PostgreSQL использовать только disposable loopback `AELYS_TEST_AI_POSTGRES_ADMIN_URL`, skip отразить явно.

## Открытые вопросы и проверка перед реализацией

1. Владелец принял PROPOSED расписание и polling 30 с; предел 24 ч и отсутствие ручного инструмента оставляют исчерпанные строки без автоматического восстановления.
2. Владелец согласовал защиту по attempts без lease; при неустранимой в этой схеме потере — остановиться.
