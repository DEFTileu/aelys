# Aelys design audit: code vs. design

Code read on Nov 2, 2026 (`apps/web/src`). The reference is `DESIGN_SYSTEM.md` plus the DC files in this project.
Each item gives **what is wrong**, **where**, and **what it should be**.

---

## P0: visible right away, fix first

### 1. Russian strings in the UI (DESIGN_SYSTEM §10: English only)
- `views/SettingsView.tsx:35,38,46,48,62,71,79` — "Погода и город", "Безопасность", "Компоненты", "Выходим…", the sign-out messages. → "Weather & location", "Security", "Signing out…" and so on. Remove the "Компоненты" link entirely (see item 3).
- `views/TelegramSettings.tsx:10–32, 102–166` — the whole screen and all error texts are in Russian. → English. The screen itself is redone in P1 item 9.
- `views/HomeView.tsx:137,158–160,210` — the "Демо-данные" banner, "Показать демо", and the help text about Auto. → remove the demo banner from Home; remove the Auto text together with Auto (item 4).
- `views/desktop/homeWidgets.tsx:65` and `views/desktop/DashboardDemoWeather.tsx:4–9` — "Алматы · демо", "Переменная облачность", "Вымышленный прогноз…". → remove the demo weather. With no city set, show one "Set location" button.
- `components/Weather.tsx:68` and `lib/weather.ts:121` — "Автоматическое определение включено", "Текущее местоположение", "Отключить погоду". → "Automatic location on", "Current location", "Turn off weather".
- `components/controls/SelectionControls.tsx:12` — placeholder "Выберите вариант". → "Choose an option".
- Tests that check the Russian strings (`telegram-settings.test.tsx`, `weather-source.test.ts`, `selection-controls.test.tsx`) → update them to the English strings.

### 2. Widgets in the sidebar and the app list (§7: the sidebar never grows; Widgets is not a page)
- `data/navigation.ts:23`, `components/AppShell.tsx:49` — the "Widgets" nav item. → replace with **Apps** (`/apps`). Widgets are added only through Home › Customize › Add widget.
- `navigation.ts:11` — "Today". → **Home**.
- `components/MobileShell.tsx:28` — "Widgets" in APPS → remove.
- `data/desktop/settings.ts:23–24,82` — "Home screen" and "Widgets" inside Settings → remove (Home is configured only through Customize).

### 3. The developer Components gallery is visible to users
- `components/MobileShell.tsx:29` — "Components" in the mobile app list → remove.
- `SettingsView.tsx:53,71` — the link to `/components` → remove.
- `lib/router.ts:5` — keep `/components` only when `import.meta.env.DEV`.
- The "Компоненты" button on the unlock screen → remove.

### 4. Auto sizing of widgets (§6: the size never changes by itself)
- Delete the file `views/desktop/automaticWidgetSize.ts` and `tests/automatic-widget-size.test.ts`.
- `HomeView.tsx:11,213` — `savedSpan === 0 ? automaticWidgetSize(...)` → migrate 0 to the widget's default size.
- `WidgetFrame.tsx:100,115` — `data-sizing="auto"` and the `StyledSelect` size picker with the "Auto" option → remove the select entirely.
- `MobileCustomizeView.tsx:26,28` — the "Auto" button and the size radio group → remove (item 6).
- `homeLayout.ts:42` `WIDGET_SIZES` → exactly **S 1×1, M 2×1, L 2×2, Tall 1×2**. Square cell 264×264, gap 16.
- Tests `dashboard-layout.test.tsx:44,66–74,196`, `mobile-customize.test.tsx:34,46`, `home.test.tsx:20` ("9 widgets") → rewrite for the new rules.

### 5. Same body for every widget size
- `homeWidgets.tsx` renders one body and just cuts the rows. → **a separate layout for S, M and L** for each widget, as in `Aelys Widgets & Utilities.dc.html` §1 (Today S = big number + next task; Calendar M = timeline; Focus L = sessions + week; Weather L = 5 days, etc.).

---

## P1: screens that need to be rebuilt

### 6. Customize
- `WidgetFrame.tsx` — the ↑/↓ arrows and the size select on the card. → only: drag the card to move, drag the corner to resize (snaps to S/M/L/Tall with a size badge), and "−" at the top left. Keyboard: arrows, Shift+arrows, Delete.
- `MobileCustomizeView.tsx` — a form with Widgets/Actions/Appearance tabs and a list with arrows. → edit mode directly on Home (long-press). `/widgets` → the "Add widget" sheet. Reference: §2.

### 7. AI Chat (`views/AiView.tsx`)
- `:112` — an ApiStatusPill and an "AI settings" button in the header. → remove both. In their place goes a **model pill** that opens the picker.
- `:113` — `SelectField` "Chat provider" with `kind · default_model`. → the model picker per §8f: Auto + providers grouped with status, models (name, one line on what it's for, context, speed, cost, capability icons), Reasoning effort (Off / Low / Medium / High), "Use for new chats", "Manage providers ›". There are no efforts in the code at all — `routing` has no `effort` field.
- `:72` — `routing.model` is taken from `default_model`. → from the picked model of the current chat.
- No run steps, no Stop, no Copy/Regenerate/👍👎, no meta "model · time · tokens". → add these per §8f. Reference: `AelysChat.dc.html`.
- Right column "What Aelys can see" (source switches) + "This chat" (context, cost) → add.

### 8. Timer (`views/TimerView.tsx`)
- `:67` — the "Track focus sessions" bar + ApiStatusPill + Refresh. → remove.
- `:77–79` — three `SelectField`s (Mode, Task, Project). → a Focus / Break / Stopwatch segmented control, preset chips 25/50/90, one task pill, a 320px ring with the time at 72px, and the coral Start/Pause as the only primary button. Reference: §3.

### 9. Settings (`SettingsView.tsx`, `TelegramSettings.tsx`, `ProviderSettings.tsx`)
- No Profile, Notifications or Data & about sections. → add them. Groups: Account / General / Assistant / System. Reference: `AelysSettings.dc.html`.
- `:55` — an ApiStatusPill in the Connection header. → a green status row at the top of the section.
- Telegram: `<details>` disclosures, a raw `<input>` for the model, and a `SelectField` for `kind · id`. → a status card + Disconnect, an Auto-reply switch, "Reply with" (the same model picker), Instructions with a counter. **Move the messages and drafts out of Settings** into the new **Messages** app (`AelysMessages.dc.html`).
- `ProviderSettings.tsx:26` — one model with `context_tokens: 100000` hard-coded. → a list of models per provider with `description`, `speed`, `cost`, `capabilities`, `context_tokens`.
- Appearance: no wallpaper picker. The photo is chosen automatically by the weather and time of day.

### 10. Automation and Developer Hub (`views/ModuleView.tsx`)
- `:119` — one shared template for both: banner + ApiStatusPill + Refresh + list. → two separate screens:
  - Automation: a "When → Then" rule card with a policy chip and a switch, a "Describe a rule" AI field, Recent runs, and a **first-run guide** with templates (§8c).
  - Developer Hub: sessions list + detail (Sandbox / Network / Running for, a dark mono log).
- Both open from **Apps**, not from the sidebar.

### 11. Apps (a new `/apps` screen)
- Doesn't exist. → the Apps page with groups, Pinned, search, and **Your sites** (the user's own links: add / edit / remove). Reference: `AelysApps.dc.html`.

---

## P2: consistency and polish

### 12. ApiStatusPill everywhere
- Present in `CalendarView:178`, `ProjectsView:154`, `NotesView:145`, `MailView:130`, `FinanceView:108`, `KnowledgeView:79`. → remove it from headers. The connection state shows only when there's a problem (the "Taking longer than usual" / "Can't reach Aelys" card, §8d).

### 13. Refresh buttons
- `MailView:130`, `FinanceView:108`, `TimerView:67`, `ModuleView:119`, `TelegramSettings:139`. → remove. Data refreshes in the background (stale-while-revalidate). On an error, use the Retry in the error card.

### 14. Page loading
- Each screen has its own `*State` component (`NotesState`, `CalendarState`…). → one route-level skeleton per §8d: 200ms delay, the skeleton in the shape of the screen, after 2.5s "Taking longer than usual", offline → "Can't reach Aelys". Reference: `AelysSkeleton.dc.html`.

### 15. Rich text
- `NotesView.tsx:149` — a separate "Preview / Edit" toggle and a "Markdown" source mode in `RichTextEditor.tsx:52`. → a single WYSIWYG mode with a toolbar and markdown shortcuts (§8e). Remove the Preview toggle.
- The task description in `TaskEditor.tsx` → the same editor.
- `NotesView` shows `v{version}` in the list and the header. → remove. The version matters only on a conflict.

### 16. Tasks (`TasksView.tsx:307`)
- `<details>` "More" holding three selects plus the status select. → one row: tabs + search + a "Filter" button with a popover. Quick add is one field, and the chips (date, priority, project) appear while you type.

### 17. Mail (`MailView.tsx:130`)
- `<details>` "Mail tools" with 7 Gmail buttons in the header. → the Gmail account and its actions go to Settings › Connected accounts. In Mail, leave Compose and one "⋯" menu (Import .eml, Load older).

---

## Definition of done
- `grep -rP '[А-Яа-яЁё]{3,}' apps/web/src --include=*.tsx --include=*.ts` → only `tests/fixtures` and i18n.
- `automaticWidgetSize`, `'auto'` in the widget code, `Widgets` in the nav, `Components` in user menus → 0 matches.
- `ApiStatusPill` appears only in one place: the global offline/slow card.
- Light and dark screenshots at 1440 and 390 for each screen, next to the matching DC reference.
