# Aelys — Architecture Decision Register

| ID | Решение | Статус | Последствие |
|---|---|---|---|
| ADR-001 | Имя продукта — **Aelys** | DECIDED | Идентификаторы `aelys-*`; брендинг позже |
| ADR-002 | Весь проект Open Source, self-hostable | DECIDED | Никаких секретов в git, portable deployment |
| ADR-003 | Личная система с одним владельцем экземпляра | DECIDED | Простая продуктовая модель; устройства аутентифицируются |
| ADR-004 | Web + macOS + Android APK | DECIDED | Общие контракты/логика, разные адаптеры хранения |
| ADR-005 | React/TS, FastAPI/Python, PostgreSQL, Tauri 2+Rust на Mac | DECIDED | Monorepo, API-first |
| ADR-006 | Android через Tauri 2 | PROPOSED / SPIKE | Проверить фон, нотификации, secure storage |
| ADR-007 | Unified Projects + Resources links | DECIDED (идея); PROPOSED (схема) | Нет копий данных по проектам |
| ADR-008 | Полный расширенный набор модулей как целевой MVP | DECIDED | Нужны отдельные milestones, а не один выпуск |
| ADR-009 | Offline-first доступные локально функции | DECIDED | Локальное durable storage + sync-протокол |
| ADR-010 | Claude Code + Codex CLI, чтение + remote management | DECIDED | macOS helper/runtime, адаптеры и аудит |
| ADR-011 | Полный текст агентских сессий только на Mac; в облаке только минимальный индекс | DECIDED | Нет remote cloud semantic search без Mac |
| ADR-012 | Без отдельных подтверждений в заранее выбранных проектах | DECIDED | Sandbox/политика границ; внешние side effects отдельные разрешения |
| ADR-013 | Сначала собственные модули, внешние подключения позже | DECIDED | Mail и Telegram MVP требуют оговорённого исключения/режима |
| ADR-014 | Rule-based automatic safe actions | DECIDED | Policy Engine checks every tool call |
| ADR-015 | BYOK и автоматический Model Router | DECIDED | Registry возможностей, бюджет/лимиты/ручной override |
| ADR-016 | Modular Monolith + Mac local runtime | PROPOSED | Простая разработка, минимальная распределённость |
| ADR-017 | SQLite macOS/Android, IndexedDB Web | PROPOSED | Offline data и синхронизация |
| ADR-018 | SSE AI events, outbound WS Mac runtime | PROPOSED | Event streams + reconnect/poll fallback |
| ADR-019 | Apache-2.0 | PROPOSED | Прежде чем публиковать LICENSE, утвердить |
| ADR-020 | Gmail в MVP как живая интеграция | OPEN | OAuth и объём прав пока не утверждены |
| ADR-021 | Политика backup, включая локальные agent sessions | OPEN | Не нарушать local-only по умолчанию |
| ADR-022 | Framework/SDK для Agent Harness | OPEN | Выбирать после capability spike |
| ADR-023 | Автоматические внешние операции (git push, send email и т. п.) | OPEN | Не включать в проектный доступ автоматически |
| ADR-024 | UI/UX, VPS, домен, брендинг | DEFERRED | Не блокируют model/API design |

## Правило при конфликтах требований

`DECIDED > PROPOSED`; OPEN фиксируется явно, а не подменяется выбором агента. Нельзя толковать «полный доступ к проекту» как разрешение читать SSH-ключи, весь `$HOME`, другие репозитории или делать необратимые внешние операции вне отдельной политики.
