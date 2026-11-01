# Реализованный срез и границы — 2026-11-01

Ветка feat/telegram-personal-assistant, Phase 3 task 5: реализованы общий
`domains/capture.py`, шесть явных личных команд, `domains/briefings.py`, opt-in
сводка, delay секретаря, reply/no_reply/handoff, TTL занятости и настройки.
Рабочие модели — `core/models.py`, REST — `domains/api.py`. Несмонтированный
`domains/productivity.py` не изменялся. Уточняющий вопрос — обычный reply,
отдельного clarify нет. Сводка без AI. Один Aelys bot на personal + Business.

ОТЛОЖЕНО: voice/media, attachments, AI memory, RAG/embeddings, Google Calendar,
MCP, /remind/Telegram reminders, task matrix, shortlist/rolling summary, импорт
и изменения MySDU. **Sheets monitor полностью остаётся в MySDU.** Ничего из
MySDU не копировалось и не удалялось. Ниже сохранён более широкий аудит будущих
кандидатов: его шаги за пределами указанного среза не реализованы этой задачей.
Подробная приёмка/ограничения: [TELEGRAM_PERSONAL_ASSISTANT_REPORT.md](TELEGRAM_PERSONAL_ASSISTANT_REPORT.md).

# MySDU → Aelys: список и план реализации

Обновлено: 2026-11-01. Задача: Phase 0 из `IMPLEMENTATION_PLAN.md` — исследование
существующего проекта и фиксация предположений перед расширением интеграций.

Владелец попросил найти полезные личные функции MySDU для переноса в Aelys
с последующим удалением старых реализаций. Этот документ — список предложений
и порядок миграции, не утверждение о выполненном переносе и не расширение MVP.
Код и данные MySDU не изменялись.

**DECIDED (владелец, 2026-11-01): Sheets monitor полностью остаётся в MySDU
для отслеживания оценок.** В Aelys не переносим monitor/followings, подписки,
snapshots, jobs, команды и экран Followings. В MySDU их не отключаем и не удаляем.

Текущий запрос — собрать план и объяснить размещение реализации. Новые файлы
ниже обозначают предлагаемые точки реализации, а не уже готовый код. Состав
первой поставки остаётся предложением; обязательный MVP, UI-дизайн и выбор
инфраструктурного провайдера этот документ не меняет.

Проверены backend `sdu-platofrm` (HEAD `81f6c3c`) и frontend
`sdu-platform-front`, включая текущие незакоммиченные изменения. Граф проекта
построен по более старому `5aae137f`, поэтому выводы сверены с исходниками.
Ниже пути MySDU указаны относительно соответствующего репозитория.
Секреты, базы и личная переписка для исследования не читались.

## Что переносить

Приоритет отражает предлагаемую полезность для личного Aelys, а не утверждённый
порядок разработки. Наличие реализации и тестов в MySDU не означает проверенную
работоспособность в Aelys.

| № | Приоритет | Что есть в MySDU | Польза для Aelys и отличие от текущего состояния | Что делать со старой реализацией |
|---|---|---|---|---|
| 1 | Первый | Личный Telegram AI: команды, контекст ответа/цитаты, создание и изменение задач | Управлять своим Personal OS из личного чата с ботом. Личные команды, queued AI-диалог и версия/CAS изменения задач реализованы в Aelys; live-check ещё требуется | Убрать личные команды и персональный режим после переноса; оставить студенческие команды и нужный им AI |
| 2 | Первый | Развитый секретарь: ожидание ручного ответа, обработка серии сообщений, `reply/no_reply/handoff`, уведомление владельца о важном | Улучшить уже существующий Business-коннектор Aelys. Перенести поведение поверх его Policy Engine, атомарной отправки и защиты от повторов | После миграции отключить старый Business worker и handlers, чтобы один аккаунт не получал ответы от двух исполнителей |
| 3 | Первый | Временный контекст секретаря: «занят до 18:00», срок действия, разграничение shareable/private | Задавать доступность и краткие инструкции через личного ассистента. Реализованы /busy и /free с TTL; произвольная коллекция private/shareable фактов отложена | Перенести только выбранные владельцем записи; затем убрать личные context tools из MySDU |
| 4 | Первый | Фото, голос, PDF, текст и код как вход AI; голос → транскрипция → инструменты задач | Быстрый захват задач и заметок из сообщений и файлов. Текущий Business-срез Aelys принимает только текст | Убрать персональные сценарии после миграции; общий обработчик медиа сохранить, если нужен учебным функциям |
| 5 | Первый | Долговременная память: факты/предпочтения/цели, источники, confidence, TTL, дедупликация, просмотр, забывание и feedback «неверно» | Управляемая память личного ассистента. В проверенном Aelys нет аналогичного завершённого контура памяти | Перенести только факты владельца с источниками; не удалять чужую или групповую память вместе с ними |
| 6 | Первый | Дедлайн-напоминания и вечерняя сводка: важность, статус, просрочка, возраст/застой задач, AI-рекомендация | Объединить Tasks/Calendar/Focus в полезную личную сводку и доставлять разрешённые уведомления. Реализованы детерминированные /today и opt-in сводка; AI-рекомендации и доставка reminders отложены | Убрать персональный digest только после переключения доставки; академические напоминания MySDU сохранить |
| 7 | Следующий | Поиск по материалам: извлечение текста, чанки, embeddings, ссылки на источники; гибридный поиск памяти vector + lexical/RRF | Расширить Knowledge/Search для своих документов и проектов. Переиспользовать алгоритмы и тестовые сценарии | Личный индекс перенести по разрешённым данным; учебную библиотеку и Moodle-источники оставить в MySDU |
| 8 | Следующий | Матрица Эйзенхауэра, board/list, привязка файлов к задачам, timestamps начала/завершения | Расширить текущие Tasks, сохранив offline/versioned-модель Aelys. Полезнее перенести правила и тесты, чем весь старый экран | Отделить личные задачи от homework по владельцу и учебным связям; не удалять общий homework-модуль |
| 9 | Следующий | Google Calendar: общий оркестратор синхронизации, события уроков, дедлайнов и академического календаря | Добавить опциональный внешний календарь к собственному календарю Aelys. Этот коннектор пока отложен в его документах | Личное подключение переключить после миграции; учебный экспорт расписания не удалять |
| 10 | Оставить в MySDU | Google Sheets followings: снимки строк, изменения оценок, потеря доступа и восстановление | Не входит в перенос по прямому указанию владельца | Сохранить все подписки, snapshots, monitor, jobs, команды, экран и зависимости |
| 11 | Следующий | MCP server: группы инструментов, внешние AI-клиенты, тесты контрактов | В перспективе открыть разрешённые ресурсы Aelys внешним клиентам. Сохранить его identity/device scopes и проверку действий | Оставить в MySDU академические инструменты; убрать личные дубликаты после появления соответствующих Aelys tools |
| 12 | Технический | Rolling summary длинного чата, shortlist инструментов по намерению, trace/feedback «почему ответил» | Уменьшить контекст/стоимость и сделать ответы понятнее. В Aelys уже есть harness, registry, бюджеты и аудит; второй agent loop не нужен | Адаптировать отдельные функции; общий AI runtime MySDU не удалять, пока он нужен учебным сценариям |

Gmail не выделен как самостоятельный первый перенос: Aelys уже реализует OAuth,
чтение и черновики. В MySDU полезны отдельные примеры интеграции с AI/MCP,
но переносить второй Gmail-модуль целиком нет смысла. Отправку писем из MySDU
не включать автоматически: в Aelys она не разрешена текущим решением.

Pomodoro также не требует второго самостоятельного модуля: он есть в обоих
проектах. Конкретные недостающие сценарии следует сравнивать с Timer Aelys
отдельно; его offline-ограничения старый web-таймер сами по себе не решают.

## Где искать исходники и тесты

Все backend-пути ниже относятся к MySDU, если явно не указан frontend.

| Область | Основные исходники | Примеры имеющихся тестов |
|---|---|---|
| Личный бот и инструменты задач | `presentation/bot/command_catalog.py`, `presentation/bot/handlers/ai_agent.py`, `application/ai_agent/reply_context.py`, `application/ai_agent/tools/homework_tools.py` | `tests/application/ai_agent/test_tool_planner.py` |
| Секретарь и передача важного владельцу | `application/business/generate_business_reply.py`, `application/business/log_business_message.py`, `presentation/bot/scheduler/jobs/business_reply_sweep.py` | `tests/application/business/test_first_person_reply.py`, `test_identity_and_boundaries.py`, `test_should_auto_reply.py`; `tests/bot/scheduler/test_business_reply_sweep.py` |
| Контекст/доступность владельца | `application/business/owner_context.py`, `application/business/availability.py`, `application/ai_agent/tools/business_tools.py` | `tests/application/business/test_owner_context.py`, `test_availability.py` |
| Голос и файлы | `application/ai_agent/media/ingest.py`, `application/ai_agent/voice.py`, `presentation/bot/handlers/voice_tasks.py` | `tests/application/ai_agent/media/test_ingest.py`, `tests/bot/handlers/test_telegram_files.py` |
| Память и поиск | `application/ai_agent/memory/`, `domain/entities/memory_fact.py`, `domain/services/rank_fusion.py`, `application/ai_agent/materials/` | `tests/application/ai_agent/memory/`, `tests/application/ai_agent/materials/`, `tests/domain/services/test_memory_safety.py` |
| Задачи и сводки | `application/homework/tasks.py`, `task_state.py`, `reminders.py`; `domain/services/task_timing.py`; frontend: `src/pages/Tasks.tsx` | `tests/domain/services/test_task_timing.py`, `tests/application/test_evening_digest.py`, `test_deadline_reminders.py` |
| Google и followings | `application/google/sync_user_calendar.py`, `application/followings/monitor.py`, `snapshot.py`; frontend: `src/pages/GoogleSettings.tsx`, `Followings.tsx` | `tests/application/google/`, `tests/application/followings/test_monitor_recovery.py` |
| MCP и экономия контекста | `mcp_server/server.py`, `application/ai_agent/history_summarizer.py`, `tool_planner.py` | `tests/test_mcp_tool_contracts.py`, `tests/test_mcp_qa_gmail_tool_contracts.py`, `tests/application/ai_agent/test_tool_planner.py` |

## Что оставить в MySDU

- SDU portal/client/parsers, авторизацию студента и восстановление его сессии.
- Расписание, подбор комбинаций, квоты, autopicker и course registration.
- Оценки, посещаемость, QR, академический календарь, кабинеты и преподавателей.
- Moodle: учебные дедлайны, оценки, файлы и связи с курсами.
- Общие homework, учебные материалы, Q&A/quiz и групповые учебные функции.
- Google Sheets monitor целиком, включая Google-доступ и Telegram-уведомления
  об оценках. Его credentials, adapters и scheduler jobs сохраняются.
- Многопользовательскую модель и инфраструктуру, пока они обслуживают студентов.

Для своих учебных данных Aelys впоследствии может использовать адаптер MySDU.
Это предложение интеграции, не решение перенести университетский backend
внутрь Personal OS. University Hub пока остаётся вне обязательного MVP Aelys.

## Где реализовывать в Aelys

Backend остаётся модульным монолитом `backend/app`. Общие типы и API-клиент —
`packages/shared/src`; интерфейс — `apps/web/src`. Web-клиент используется
Web/macOS/Android; platform storage и offline поведение проверяются отдельно.
Второй backend бота, AI runtime или Tasks-модуль не нужен.

Перед работой проверять ветку, git status и cwd запущенных процессов. При
диагностике 2026-10-31 порт 5173 обслуживал `desktop-design` worktree, а 8000 —
основной checkout. Изменения интегрируются из одного источника; результат
проверяется на фактически запущенном frontend/backend.

### 1. Личный Telegram-ассистент — первая вертикальная задача

**Что реализовать:** `/task`, `/note`, `/today` в личном чате владельца;
контекст reply/quote, затем свободный AI-диалог и управление существующими
задачами. Личные команды, учебный бот и внешние Business-клиенты разделяются.

- Расширить существующие `backend/app/integrations/telegram_service.py`,
  `telegram_models.py`: private-message dispatch, verified owner, durable receipt
  и cursor. Новый `telegram_personal.py` в той же папке — разбор команд.
- Выделить общие операции из `backend/app/domains/api.py` и `backend/app/core/models.py` в предлагаемый
  `capture.py`. REST, бот и `backend/app/ai/api.py` должны вызывать
  одни domain services. Сейчас AI registry содержит отдельные операции создания;
  ещё один независимый путь записи добавлять не нужно.
- Настройки: текущие `telegram_api.py`, `packages/shared/src/telegram.ts`,
  `api-client.ts`, `apps/web/src/views/TelegramSettings.tsx`.
- Каталог личных AI tools расширять в текущем registry: read/update/complete
  tasks и Calendar через typed contracts и Policy Engine.

**Приёмка:** чужой Telegram ID ничего не читает и не создаёт; повтор update
после рестарта не создаёт второй объект; подтверждение идёт после commit;
все действия проверяет Policy Engine. Тесты: новый
`backend/tests/test_telegram_personal.py`, существующие Telegram и web tests.

**DECIDED 2026-11-01:** один токен Aelys для personal/Business.
Нельзя забирать у MySDU токен, нужный Sheets, или одновременно опрашивать один
токен двумя poller. Aelys bot отделён от MySDU; внутри Aelys второго poller нет.

### 2. Развитый Business-секретарь

**Что реализовать:** ожидание твоего ручного ответа, объединение серии сообщений,
решения `reply/no_reply/handoff`, уведомление владельца о важном.

- `backend/app/integrations/telegram_ai.py`: типизированное решение и валидация
  ответа; заметка владельцу не должна попадать собеседнику.
- `telegram_service.py`: per-chat окно ожидания в текущем worker, проверка
  актуальности после LLM, отмена автоответа при ручном ответе.
- `telegram_models.py` + Alembic: timestamps/decision/cursor для очереди.
- Существующие `telegram_api.py`, shared contracts и `TelegramSettings.tsx`:
  настройки задержки и понятное состояние. Эскалация проходит notification
  policy. Текущие CAS/lease, права Telegram, окно 24 часа, budget и terminal
  unknown-delivery сохраняются.

**Приёмка:** серия входящих даёт один актуальный ответ; ручной ответ отменяет
черновик; no_reply не шлёт пустое сообщение; handoff виден только владельцу;
timeout не дублирует отправку. Расширить `test_telegram_business.py`,
`test_telegram_ai.py` и web tests.

### 3. Временный контекст секретаря

**Что реализовать:** «занят до 18:00», TTL, просмотр/очистка, явная видимость.

- Новый предлагаемый `backend/app/integrations/telegram_context.py`: валидация,
  срок действия, источник, owner scope. Шифрованные записи — в Telegram models
  с миграцией; управление через owner API и ограниченные tools общего registry.
- `telegram_ai.py`: передавать только разрешённые к раскрытию факты. Private
  текст нельзя защищать лишь фразой в prompt «не раскрывай»; личную память
  целиком в prompt внешнего секретаря не включать.

**Приёмка:** TTL/timezone, clear/revoke, изоляция owner и отсутствие private
данных в prompt. Новый `backend/tests/test_telegram_context.py`.

### 4. Голос, фото, PDF и вложения

**Что реализовать:** голос → транскрипция → задача/заметка; обработка изображения
и документов выбранной моделью; связи вложений с существующими ресурсами.

- Предлагаемые `backend/app/ai/media.py`, `transcription.py`: MIME/size limits,
  capability routing, извлечение текста и BYOK adapters.
- Предлагаемый `backend/app/domains/attachments.py`: owner-scoped upload/download,
  file references, удаление. Хранилище, лимиты и offline attachment sync OPEN;
  до решения реализуется только явно ограниченный срез.
- `telegram_transport.py` и `telegram_personal.py`: безопасная загрузка без
  credential URL в логах. Сначала личный канал; Business-media — отдельный срез.
- Предлагаемый `packages/shared/src/attachments.ts`, далее `AiView.tsx` и
  редакторы Notes/Tasks — функциональная интеграция, без нового UI-дизайна.

**Приёмка:** большие/неподдерживаемые файлы отклоняются, доступ проверяется,
данные получает только разрешённый provider, повтор не дублирует task.
Новые media/attachment tests; SDK/провайдер из MySDU не закрепляется автоматически.

### 5. Память AI и управление контекстом

**Что реализовать:** факты/предпочтения с источниками, TTL, дедупликацией,
просмотром, исправлением и забыванием; summary длинного обычного AI-чата.

- Предлагаемые `backend/app/ai/memory/{models,service,retrieval,api}.py`:
  owner/project scope, versioned mutations, provenance; tools в текущем registry.
- Предлагаемые `backend/app/ai/context.py`, `tool_planner.py`: bounded summary,
  shortlist инструментов и метаданные «почему ответил». Shortlist не даёт прав.
- Shared contracts в предлагаемом `memory.ts`; просмотр через существующие
  `AiView.tsx`/`KnowledgeView.tsx`.
- Размещение памяти/индекса и разрешение embeddings OPEN. Первым ограниченным
  вариантом может быть явное сохранение + lexical retrieval без облачного
  embedding. Это предложение, не окончательное решение о размещении.
- CLI transcripts, их summaries и embeddings не идут в этот backend pipeline:
  они остаются в Mac runtime согласно существующим ограничениям.

**Приёмка:** forget исключает факт и из производных индексов; неверный/истёкший
факт не используется; retrieval не повышает доверие к содержимому; Business
и group каналы не получают личную память по умолчанию. Новые memory/context
tests в `backend/tests/ai_automation/`.

### 6. Tasks, сводки и напоминания

**Что реализовать:** матрица важности/срочности, точное время переходов статуса,
застой задач, вечерняя сводка и рекомендации на завтра, выбранные каналы доставки.

- Расширить `backend/app/domains/api.py` и `backend/app/core/models.py` и общий domain service,
  shared task contracts, `TasksView.tsx`, `views/tasks/TaskEditor.tsx`.
  Timestamps/history — через миграции. Матрица использует те же tasks.
- Предлагаемый `backend/app/domains/briefings.py`: сводка Tasks/Calendar/Focus
  с источниками, сначала детерминированная; AI-рекомендация опциональна.
- `backend/app/automation/engine.py`, `domains/reminders.py` и предлагаемый
  notification delivery adapter: schedule, outbox/dedup, quiet hours, pause,
  channel policy. Сначала проверить возможности текущего automation engine;
  не копировать весь APScheduler MySDU в независимый scheduler.
- Offline mutations проходят текущий client outbox и `backend/app/sync`.

**Приёмка:** version conflict не теряет правки; время корректно после повторных
переходов; job replay не дублирует доставку; quiet hours/pause соблюдаются.
Расширить task/sync/reminder/automation tests, добавить briefing tests.

### 7. Поиск по своим материалам

**Что реализовать:** извлечение текста, индексация и ответы по разрешённым
документам со ссылками на источник, обновление/удаление индекса вместе с файлом.

- Расширить `backend/app/domains/search.py`; новые indexer/extraction/retrieval
  компоненты — в предлагаемом `backend/app/knowledge/`.
- Использовать attachments шага 4 и retrieval-примитивы шага 5; lexical первым,
  hybrid/RRF после решения об embeddings.
- Выдача через `KnowledgeView.tsx`, `SearchView.tsx`, `AiView.tsx`, shared API.
  Mac CLI content не импортируется в backend knowledge index.

**Приёмка:** source/project scopes, проверяемые цитаты, reindex/delete,
отсутствие чужих источников, честное поведение при offline источнике.

### 8. Дополнительные интеграции после ядра

- **Google Calendar:** предлагаемый `backend/app/integrations/google_calendar.py`
  поверх native Calendar и encrypted secret store; Settings/shared API.
  OAuth scopes и направление sync OPEN. Нужны stable external IDs, отсутствие
  дублей и понятный disconnect. Академический экспорт MySDU остаётся там.
- **MCP:** предлагаемый `backend/app/integrations/mcp/` либо локальный transport
  после выбора режима. Общие registry/domain services/policy; минимальные
  read scopes, отдельные write grants, revocation и contract tests. Защиты
  транспорта не отключаются по примеру старого deployment.
- **Gmail/Timer:** дорабатывать текущие модули Aelys по конкретным пробелам.
  Вторые реализации не переносить; Gmail send остаётся вне текущего разрешения.
- **Sheets monitor:** никаких реализаций в Aelys в рамках этого плана.

Для каждого persisted API: `/api/v1`, Pydantic input/output, version/CAS,
идемпотентность записей/эффектов, Alembic и shared/OpenAPI contracts по факту
среза. Номера миграций назначаются по актуальному HEAD.

## Что удалять из MySDU после переноса

| Область | Удаляем/отключаем после приёмки в Aelys | Сохраняем |
|---|---|---|
| Business secretary | Личный worker, handlers, context tools и команды | Студенческого бота и notification transport |
| Личный AI | Только персональные надстройки, ставшие дубликатами | Учебные tools, общий runtime, group/quiz/explain |
| Memory/media/RAG | Выбранные личные записи и неиспользуемый после отделения код | Студенческие данные, учебные материалы и общие компоненты |
| Tasks/digests | Личные дубли и персональные jobs после сверки импорта | Homework, Moodle deadlines, академические напоминания |
| Google | Только личные Calendar/Gmail привязки, если мигрируют | **Sheets monitor, подписки/snapshots, credentials, jobs и уведомления оценок** |
| MCP | Личные tool-дубли после переключения клиентов | Академические инструменты |

Общие таблицы/каталоги целиком удалять не планируется: сначала callers и
зависимости, затем mapping выбранных личных записей и проверка импорта. Старые
credentials не копируются в Markdown/fixtures. MySDU bot остаётся доступен
для Sheets; при смене исполнителя нужен устойчивый cursor без двух poller.

## Что не копировать буквально

- `student_id` как основную identity личного ассистента и `ADMIN_IDS` как замену
  Aelys owner/device permissions. Понадобится явное сопоставление идентификаторов.
- Общую память личного агента в контекст внешнего секретаря. Передавать ему
  только явно разрешённые факты; доступность выдавать без названий личных дел.
- Облачные embeddings/истории для Mac CLI. Ограничение Aelys local-only остаётся.
- Gemini-специфичный runtime/key pool вместо существующего BYOK harness Aelys.
- Отключение MCP DNS-rebinding protection из старой конфигурации сервера.
- Социальные `roast/flirt`, массовые рассылки, premium/payments и админский SQL:
  для текущего переноса пользы не обосновано.
- Предположение, что `time_in_current_column` — точная история переходов:
  текущая функция для done считает created → done, а не пребывание в done.

## Порядок переноса и удаления

1. Начать с личного Telegram capture и улучшений секретаря. Сохранить существующие
   Aelys policy/claim/idempotency/unknown-delivery проверки. Сам Telegram должен
   предоставлять `can_reply`; перенос кода отсутствующее право не выдаёт.
2. Добавить управляемую память и мультимодальный захват. Для импорта выбрать
   конкретные личные факты/файлы; секреты не копировать как данные памяти.
3. Подключить сводки, поиск и выбранные внешние адаптеры по отдельным задачам.
   Sheets monitor в перенос и последующее удаление не входит.
4. Для каждого среза проверить реальный сценарий в Aelys, перенести выбранные
   данные с mapping старых ID и ссылок, затем переключить одного исполнителя.
   Один токен бота не должен одновременно опрашиваться двумя poller-процессами.
5. Только после проверки убрать старые личные handlers, commands, jobs и tools.
   Сначала остановить исполнение, затем удалить код. Общие компоненты удалять
   лишь после проверки их зависимостей и тестов академических сценариев.
   Старые личные данные удалять отдельно после сверки импорта; таблицы целиком
   не удалять, если в них остались учебные или чужие записи.

Исторические OPEN аудита уточнены ADR-028: обязательный личный scope утверждён,
память — encrypted backend DB с лексическим отбором, Google Calendar — readonly;
MCP/RAG/document search исключены. Хранилище вложений и судьба общих MySDU
features остаются OPEN. Текущее выполнение Aelys отражено в отчёте ниже.

Проверка аудита: статический просмотр реализации и тестовых файлов,
сопоставление с Aelys `INTEGRATIONS.md`, `AI_HARNESS.md`, Telegram и domain code.
Тесты и живые внешние операции не запускались; готовность функций к переносу
или полная работоспособность MySDU этим документом не заявляются.


## Фактический прогресс Aelys — 2026-11-01, этапы 0–4

В изолированной ветке Aelys реализованы transactional domain change-log,
Telegram reminders/quiet hours/digest tomorrow, личный текстовый AI-диалог
и ephemeral voice/photo/PDF/text.
Очередь шифрована, общий AI loop/registry переиспользованы, Task CAS сохранён.
Содержимое цитат не разрешает действий; секретарь не получает личные инструменты.
Подробные файлы и автоматическая приёмка — `PERSONAL_OS_BOT_REPORT.md`.

Это не проверка живого Telegram или реального провайдера и не основание удалять
что-либо в MySDU. Код и данные MySDU не менялись, Sheets monitor остаётся там.
Ранее записанные предложения аудита — исторический список; обязательный состав
и ограничения утверждены ADR-028. Memory, matrix и Google Calendar ещё
не реализованы в этом этапе. Импорт данных, MCP/RAG/document search исключены.
