# Aelys — Open Questions / Decision Backlog

Документация пригодна для начала foundation, но ниже перечислены решения, которые не были подтверждены пользователем. Агент должен рассматривать их как OPEN, а не делать вид, что ответы уже даны.

| Приоритет | Вопрос | Безопасный временный вариант | Что блокирует |
|---|---|---|---|
| P0 | Gmail read/drafts подтверждены владельцем 2026-10-29; production OAuth verification, фоновые обновления и retention ещё открыты | Явная загрузка по 25 писем, локальные копии сохраняются после disconnect; отправка отсутствует | Production Gmail и автоматическая синхронизация |
| P0 | Telegram Business read/reply подтверждён владельцем 2026-10-29; live token/account acceptance и отдельные personal commands/notification categories ещё открыты | Secretary Mode, разрешённые личные чаты, автоответ только после настройки владельцем | Полный релиз Telegram-модуля |
| P0 | Android Tauri 2 соответствует требованиям фонового sync/push/secure storage? | Исследовательский APK-spike; fallback Capacitor | Финальная архитектура Android |
| P0 | Sandbox для macOS CLI: что реально изолируем технически? | Не запускать unattended CLI до прохода security tests | Автономный remote control |
| P1 | Backup: делать ли зашифрованную резервную копию Mac-only histories? Куда, каким ключом, срок хранения? | Нет облачного backup сессий; ручной локальный экспорт только по разрешению | Recovery сессий |
| P1 | Подключение API моделей: серверный BYOK, локальные ключи или оба варианта? | Backend encrypted secret store + ревокация, не выдавать на клиентов | Финальные threat boundaries |
| P1 | Нужен ли запуск AI offline локальными моделями? | Нет, только локальный доступ к уже сохранённым данным | Offline AI |
| P1 | Вложения Notes: лимиты, файловое хранилище и политика offline attachment sync | Локальное хранение + явно ограниченный upload | Масштаб файлового storage |
| P1 | Синхронизация конфликтующего Markdown: ручное слияние или CRDT в следующих версиях? | Branch/version conflict с сохранением обеих версий | Collaborative editor / сложное merge |
| P1 | Конкретная технология agent loop: SDK или собственный adapter loop? | Capability spike, abstraction-first | Runtime implementation |
| P1 | Лицензия: Apache-2.0 окончательно? | Держать proposed, не объявлять окончательно | Публичный release |
| P2 | Utilities: какие дополнительные форматы и настройки нужны после первой локальной поставки? | Реализовать показанный владельцу набор (PRD §2.13); история и менеджер паролей не включены | Следующие версии Utilities |
| P2 | Голос, Uni Hub, Infra Monitor — нужны ли в roadmap после MVP? | Backlog, не обязательная разработка | Future releases |
| P2 | Нужны ли версии Linux/Windows после macOS? | Нет в MVP | Cross-desktop strategy |
| P2 | Нужна ли интеграция с Google Calendar/GitHub в первом релизе? | Позже, отдельные адаптеры | External automation |
| P2 | Хочет ли пользователь публичную документацию на английском дополнительно? | Исходные инженерные документы на русском | Community adoption |

## Минимальные уточнения от пользователя перед проектированием интеграций

1. Настоящий Gmail нужен уже в первой поставке или позже?
2. Telegram должен быть рабочим ботом в первом MVP?
3. Полные агентские сессии **никогда** не резервировать вне Mac или разрешить отдельно зашифрованный backup?

Ответы не блокируют создание репозитория, Core, Projects, Notes/Tasks, offline sync и локального Session Reader.
