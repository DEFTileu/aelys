# Aelys — документация проекта

**Статус:** implementation in progress; Goal 3 release audit is active and
production deployment remains disabled.
**Версия комплекта:** 0.2 (2026-10-28).
**Язык:** русский, имена API/типов/кода — английский.

Aelys — персональная, полностью открытая (open-source) система для Web, macOS и Android: проекты, заметки, задачи, календарь, почта, финансы, таймер, Telegram, AI, история локальных Claude Code / Codex CLI и управление их запуском с других устройств.

Текущий checkout содержит рабочие backend, shared/web client, Tauri host crates
и headless Mac runtime. Локальный web/backend запуск описан в
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md); точное состояние acceptance,
платформенных блокеров и тестов — в [`RELEASE_REPORT.md`](RELEASE_REPORT.md).
Vendor execution остаётся fail-closed до credentialed CLI и macOS isolation
evidence. Web и unsigned macOS/Android development builds собраны; реальный
вход и lifecycle на устройствах, signing/notarization и внешние интеграции
ещё требуют acceptance. Проверки текущего снимка и ограничения:
[`docs/INTEGRATION_CHECKPOINT.md`](docs/INTEGRATION_CHECKPOINT.md).

Разделяйте в документации:
- **DECIDED** — подтверждено владельцем в обсуждении;
- **PROPOSED** — предлагаемая реализация, уточняется инженерным проектированием;
- **OPEN** — вопрос ещё не решён.

## Читать в таком порядке

1. [`PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) — полный исходный контекст и границы решения.
2. [`DECISIONS.md`](docs/DECISIONS.md) — принятые решения и степень определённости.
3. [`PRD.md`](docs/PRD.md) — функциональные требования и user stories.
4. [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) — компоненты, границы модулей, события.
5. [`DATA_MODEL.md`](docs/DATA_MODEL.md) — логическая реляционная модель.
6. [`API_CONTRACTS.md`](docs/API_CONTRACTS.md) — черновик REST/SSE/WS-контрактов.
7. [`SYNC_PROTOCOL.md`](docs/SYNC_PROTOCOL.md) — офлайн-редактирование, конфликтность, курсоры.
8. [`AGENT_RUNTIME.md`](docs/AGENT_RUNTIME.md) — Mac, CLI-адаптеры, локальные сессии, remote control.
9. [`AI_HARNESS.md`](docs/AI_HARNESS.md) — BYOK, tool calling, Model Router, безопасность данных.
10. [`INTEGRATIONS.md`](docs/INTEGRATIONS.md) — Mail/Telegram и внешние сервисы.
11. [`SECURITY.md`](docs/SECURITY.md) — границы полномочий и угрозы.
12. [`ACCEPTANCE_TESTS.md`](docs/ACCEPTANCE_TESTS.md) — измеримые сценарии готовности.
13. [`IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — этапы и зависимости.
14. [`OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) — неразрешённые продуктовые решения.
15. [`AGENTS.md`](AGENTS.md) — правила работы для кодинг-агентов.
16. [`GOAL_PROMPT.md`](docs/GOAL_PROMPT.md) — задание агенту для планомерного старта.

Для запуска из чистого checkout см. [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md),
а для зашифрованного single-owner export/restore —
[`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md).

## Главное правило

**Не превращать предложения в подтверждённые требования.** Если задача зависит от OPEN-вопроса, описать допущение и остановиться перед необратимым решением. Не придумывать дизайн и не выбирать VPS: эти темы намеренно отложены.

## Известные неопределённости

- Входит ли живое подключение Gmail в первый релиз или сначала локальная модель/импорт почты?
- Каков окончательный мобильный контейнер (Tauri 2 либо альтернатива после Android spike)?
- Где размещать резервные копии полного локального индекса агентских сессий, если они вообще нужны?
- Конкретные пакеты/SDK для agent loop — пока не закреплены.
- Open-source лицензия Apache-2.0 рекомендована, но окончательное юридическое решение не подтверждено.

## Что не является частью документации

UI/UX, название домена, тарифы VPS, конкретный облачный вендор и бренд-айдентика.
