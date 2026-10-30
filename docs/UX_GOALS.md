# Готовые /goal-промпты: UI/UX Aelys

Исследование и обоснование: [UX_RESEARCH.md](UX_RESEARCH.md).
Общие требования: [goals/UX_RULES.md](goals/UX_RULES.md).

В каждом файле ниже — самостоятельный текст для одного `/goal`. Можно скопировать
весь text-блок либо отправить короткую команду со ссылкой на соответствующий файл.
Цели запускать последовательно: соседние экраны используют общие компоненты.

| № | Цель | Что получает пользователь |
| --- | --- | --- |
| 1 | [Иконки и UI-foundation](goals/UX_01_ICONS.md) | Финальная визуальная итерация и приёмка уже внедрённых авторских SVG |
| 2 | [Tasks — выполнено](goals/UX_02_TASKS.md) | Быстрый ввод, Inbox/Today/Upcoming, полноценный редактор, реальные фильтры |
| 3 | [Calendar](goals/UX_03_CALENDAR.md) | Пересечения, all-day, day/week/agenda, drag/resize, понятные повторения |
| 4 | [Notes](goals/UX_04_NOTES.md) | Раздельные черновики, защита несохранённого текста, безопасный preview |
| 5 | [Finance](goals/UX_05_FINANCE.md) | Понятное создание счёта/расхода, история и точные итоги по валютам |
| 6 | [AI и настройки провайдера](goals/UX_06_AI_SETTINGS.md) | Подключить модель, вернуться в чат, stream/Stop/история |
| 7 | [Mail](goals/UX_07_MAIL.md) | Список/чтение/поиск/черновик и честные статусы Gmail |
| 8 | [Projects](goals/UX_08_PROJECTS.md) | Детали проекта, связанные ресурсы и реальный прогресс |

UX_02 Tasks реализован и проверен: [отчёт](TASKS_UX_VALIDATION.md). Следующая предложенная цель — UX_03 Calendar; она не запускалась автоматически. Notes также имеет высокий приоритет из-за возможной потери несохранённого текста. Базовый набор иконок внедрён ранее.

```text
/goal Реализуй полностью цель из <repository-root>/docs/goals/UX_02_TASKS.md. Прочти и соблюдай docs/goals/UX_RULES.md. Доведи до работающего локального интерфейса, пройди браузерные сценарии и тесты. Разрешаю до шести субагентов на независимые участки. Не переходи к следующей цели автоматически.
```

## Что сделано сейчас

- Собственный исходник 76 SVG-глифов, React API и compatibility Icon; заменены импорты Lucide, удалена зависимость.
- Новый знак Aelys в навигации/auth и favicon.
- Экспорт всех SVG, sprite и локальная [галерея](http://127.0.0.1:5173/icons/aelys/gallery.html).
- Установлены `icon-system` и `ui-ux-pro-max`; проведён аудит текущего кода модулей и официальных UX-референсов.
- Tasks реализован отдельной целью UX_02: Inbox/Today/Upcoming/All, быстрый ввод, полный редактор, фильтры и защита черновиков. Доказательства и актуальные проверки — в TASKS_UX_VALIDATION.md. Calendar/Notes/Finance/AI/Mail/Projects остаются следующими отдельными целями.

## Проверки первоначальной итерации иконок (до UX_02)

- `node apps/web/scripts/export-icons.mjs` — экспортированы 76 SVG, sprite и HTML-галерея.
- `pnpm --filter @aelys/web typecheck` — passed.
- `pnpm --filter @aelys/web test` — 15 files, 73 tests passed.
- `pnpm --filter @aelys/web build` — passed, 63 transformed modules.
- `git diff --check` — passed.
- XML parse — 78 SVG-файлов (76 глифов, sprite, mark), без script elements.
- Browser smoke: Home, Tasks, Calendar, Settings доступны; галерея осмотрена на светлом/тёмном фоне при 16/20/24/32 px. Бизнес-сценарии модулей не перепроверялись этим icon-срезом.
- Backend не изменялся этой итерацией; его полный test suite повторно не запускался.

Следующие отдельные срезы после этих целей: Focus/Timer persistence и offline
контракт; остальные пункты Settings; Telegram Business UI с уже принятыми
Policy Engine/permission constraints. Банковские выписки пользователь отложил.
