# Aelys Design System

Source of truth for every Aelys surface (web, macOS, Android). Reference designs:

- `ACTUAL Aelys Desktop.dc.html`: shell, Home, all modules
- `ACTUAL Aelys Mobile.dc.html`: mobile adaptation
- `AelysLaunch_ACTUAL.dc.html`: launch animation (variant C) and unlock
- `Aelys Widgets & Utilities.dc.html`: widget sizes, Customize, Timer, Automation, Developer Hub (reference board)
- Shared screens used by both Desktop and Mobile (`compact` = mobile): `AelysApps.dc.html`, `AelysMessages.dc.html`, `AelysSettings.dc.html`, `AelysAutomation.dc.html`

If code and this file disagree, this file wins. If this file and a reference design disagree, the reference design wins.

---

## 1. Principles

1. **Calm, not empty.** Content goes on soft glass cards over a warm beige canvas. The photo appears only on the Home hero, the Weather card and the launch/unlock screens.
2. **One primary action per view.** Only one violet (or coral, for Focus) filled button per screen.
3. **Edit in place.** No settings forms for things the user can drag. For example, Customize is direct manipulation.
4. **Show, don't label.** Content is not described in UI copy. Banned: "Synthetic visual test record", "9 widgets", "Weather in your city", and any debug pills.
5. **AI-first, never mandatory.** ⌘K is always available, and the AI composer appears on Home. Every AI action has a manual path.

## 2. Color

### Light (default)
| Token | Value | Use |
|---|---|---|
| `canvas` | `#F5F0EB` | App background |
| `sidebar` | `#FAF7F4` | Sidebar |
| `surface` | `#FFFFFF` | Inputs, modals |
| `glass` | `rgba(255,255,255,.88)` + `blur(20px)` | Cards and widgets |
| `surface-soft` | `#F7F4F1` | Secondary buttons, input fills |
| `line` | `#EDE8E3` | Card borders, dividers |
| `line-soft` | `#F1EDEA` | Row separators inside cards |
| `ink` | `#1C1B22` | Primary text |
| `ink-2` | `#3A3640` | Body excerpts |
| `muted` | `#625D69` | Meta, labels (4.6:1 on canvas) |
| `faint` | `#8C869A` | Axis ticks only; never body text |
| `primary` | `#6A4CF2` | Primary buttons, selection, checkboxes |
| `primary-deep` | `#5132D6` | Links, text on primary-soft |
| `primary-soft` | `#EEE8FD` | Selected rows, tags |

### Module accents (icon tile = accent on soft)
| Module | Accent | Soft |
|---|---|---|
| Tasks / Mail / Weather | `#2F6FE4` | `#E4EEFD` |
| Calendar | `#D93636` | `#FDE8E7` |
| Focus / Timer | `#F06A58` | `#FDE6E1` |
| Projects / Knowledge | `#6A4CF2` | `#EEE8FD` |
| Finances | `#14966C` | `#DCF5EC` |
| Notes | `#B36B00` | `#FDF1D9` |

Status colors: success `#0E7A57`, warning `#8A5A00`, danger `#C9302C`. Each status color is used on its soft tint.

### Dark
`assets/aelys-dark.css` maps every light literal to its dark value. Use only the literals listed above so the mapping keeps working. Main dark values: canvas `#141219`, surface `#201D28`, soft `#2A2733`, line `#34303D`, ink `#F1EEF6`, muted `#A6A0B2`, primary text `#B9A8FF`.

## 3. Typography
Font: **Inter** (bundled locally), tabular numerals on. Mono: **JetBrains Mono**, used only for paths, logs and code.

| Role | Desktop | Mobile |
|---|---|---|
| Hero (Home greeting) | 36 / 44 · 700 | 28 / 34 · 700 |
| Page title | 30 / 38 · 700 | 24 / 30 · 700 |
| Section | 22 / 30 · 600 | 18 / 26 · 600 |
| Card title | 16 / 24 · 600 | 16 / 24 · 600 |
| Body | 14 / 22 · 400 | 15 / 22 · 400 |
| Meta | 13 / 18 · 400 | 13 / 18 · 400 |
| Caption / eyebrow | 12 / 16 · 600 (eyebrow uppercase +.06em) | same |
| Big number (widget) | 44–72 · 700 | 36–56 · 700 |

All UI copy is in English. A Russian string in the build is a bug.

## 4. Spacing, radius, elevation
- Spacing scale: 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40.
- Page padding: 28 desktop, 16 mobile. Card padding: 18. Section gap: 16–24.
- Radius: chips 8–10 · buttons/inputs 12 · rows/sub-cards 14 · cards/widgets **20** · modals 24 · avatars full.
- Card shadow: `0 10px 30px rgba(20,10,30,.05)`. Popover: `0 18px 50px rgba(20,10,30,.22)`. Modal: `0 30px 80px rgba(20,10,30,.3)`.
- Hit targets: at least 36 desktop and 44 mobile.

## 5. Components (canonical specs)
- **Button primary:** height 40 (44 for a modal CTA), radius 12, `#6A4CF2`, white 600 text, hover `#5132D6`. Disabled = 40% opacity and shown only when the reason is obvious. Never use a pale lilac fill as a "disabled look".
- **Button secondary:** `surface-soft` fill, ink 500 text.
- **Segmented control:** track `#EFE9E3` radius 14 with 4px inset. Active segment is white radius 10 with a light shadow.
- **Chip / preset:** height 36 radius 12. Selected = ink fill and white text.
- **Switch:** 44×26. On = primary, off = `#CFC9D4`.
- **Checkbox (task):** 20px circle with a 2px `#BDB7C2` border. Done = primary fill, white check, title muted and struck through. Completing a task triggers the star burst.
- **Icon tile:** 28×28 radius 8 (list rows 36–40, radius 10–12), module accent on soft.
- **Row:** height 40–52, separator `line-soft`. The time sits right-aligned in muted.
- **Input:** height 44, radius 12, `surface-soft` or white with `line` border. The focus ring shows only on keyboard focus (`:focus-visible`): 2px primary, offset 2.
- **Quick add (Tasks):** one row containing "+ Add a task". Date, priority and project appear as inline chips **after** typing starts (or via `@date`, `!p1`, `#project`). There are no permanent selects.

## 6. Home & widgets

### Grid
- Desktop: 4 columns, square cell **264 × 264**, gap **16**. Below 1180px: 2 columns.
- Mobile: 2 columns, cell = (viewport − 32 − 12) / 2, gap 12.

### Sizes (the only sizes that exist)
| Size | Cells | Desktop px | Purpose |
|---|---|---|---|
| S | 1×1 | 264 × 264 | Glance: one number or the next item |
| M | 2×1 | 544 × 264 | Scan: short list or timeline |
| L | 2×2 | 544 × 544 | Act: full list, controls, history |
| Tall | 1×2 | 264 × 544 | Optional: S header + list |

**Each size renders a different layout.** It is not the same list with more rows. Per-widget content for each size is defined in `Aelys Widgets & Utilities.dc.html` §1:

- **Today:** S shows count left, progress and next task. M shows a 4-row list. L shows Overdue/Today/Tomorrow groups and quick add.
- **Calendar:** S shows the next event with an "In 25 min" chip. M shows today as a horizontal timeline with a now-line. L shows the month grid and agenda.
- **Focus:** S shows the ring and one button. M adds presets and the linked task. L adds the session dots, today's total and the week bars.
- **Weather (photo card):** S shows the current conditions. M adds the next 6 hours. L adds 5 days. With no location set, it shows one "Set location" button and no placeholder copy.
- **Finances:** S shows the balance and week delta. M adds daily bars. L adds categories and one budget. Currencies are never summed.
- **Projects:** S shows one pinned project with a ring. M shows 3 projects with bars. L adds each project's next task.
- **Notes:** S shows the last note excerpt. M shows 2 cards. L shows the pinned note, the recent list and a New button.
- **Mail:** S shows the unread count and avatars. M shows 3 unread. L shows the inbox with previews.

### Rules
- Size is **only** what the user picked. There is **no Auto sizing**: a card must not grow because a record was added.
- The default layout is Today M, Focus S, Weather S, Calendar M, Projects M, Finances M, Notes S, Mail S.
- Empty state is one muted line plus one action. A widget never shows an error paragraph; show "Can't load · Retry".

### Customize
- Enter with the "Customize" button or a long-press (mobile). Exit with Done or Esc.
- **Move:** drag the card body. Other cards reflow, and the drop target shows a dashed primary outline.
- **Resize:** drag the bottom-right corner. It snaps to S/M/L/Tall with a live outline and a size badge.
- **Remove:** tap the "−" badge at top-left.
- **Add:** the "Add widget" sheet. Pick a widget on the left and a size preview on the right (default M), then press Add.
- **Keyboard:** arrows move, Shift+arrows resize, Delete removes.
- **Banned:** ↑/↓ buttons, size dropdowns, "Auto", per-card toolbars, form-based Customize on mobile.
- Bodies are dimmed (55%) and inert while editing. Changes save instantly.

## 7. Shell
- Sidebar 240: logo block on top, nav, profile at the bottom. Nav item height 44, radius 12. The active item gets a primary-soft fill and primary-deep text.
- **The sidebar is a closed list:** Home, AI Chat, Tasks, Calendar, Projects, Notes, Mail, Finances, Knowledge base, Apps. A new feature must never add a sidebar item. It goes into an Apps group. There is no "Tools" group and no "Widgets" item.
- Top-right cluster: search pill (⌘K), theme, notifications. There is no weather pill in the header.
- Home hero is 220–280 tall: photo with a gradient into the canvas, and the composer sits on the boundary. Module pages use the plain canvas with no photo.
- Mobile: header with logo, search, notifications and avatar (max 3 icons). No bottom nav. The AI bar is pinned at the bottom of Home, and page content gets bottom padding equal to its height so nothing hides under it.

## 8. Utilities
- **Apps** (`/apps`, reference §0): the page title plus a search field (also ⌘K). "Pinned" sits on top, then the groups: Plan & reflect (Review, Weeks, Habits, Countdowns), Focus & calm (Focus, Breathe), Quick tools (Calculator, Zones, Decide, Toolbox), Learn & create (Cards, Reader, Type, Sketch), Power tools (Automation, Developer Hub, macOS only). Last comes **"Your sites"**: the user's own links (outlined rows, a tile with the first letter in a soft tint, mono domain). "Add site" opens an inline form (address + optional name; the name is taken from the domain). The pencil on a row edits or removes it. Stored locally and synced like the other settings. Clicking a row opens the site in the browser.
- Each tile has a 44 icon tile in its group accent, the name, a one-line description, one live glance line, and a pin toggle. Group accents: Plan blue, Focus coral, Quick violet, Learn orange, Power green.
- An app opens at `/apps/<id>` with a "‹ Apps" back link, and the sidebar keeps Apps active. Pinned apps also appear in ⌘K. Each tile menu has "Add to Home".
- **Timer:** the page title "Focus" with a segmented Focus / Break / Stopwatch control. A 320 ring with a 72px time, preset chips (25/50/90), a linked task pill, a coral Start/Pause (the only primary) and Reset. Right column: Today total + session bars, Sessions list, This week bars. No selects.
- **Automation:** each rule card reads as a sentence: **When** [trigger chip] → **Then** [action chip], plus policy chip, last run and switch on the row. An AI "Describe a rule" input sits on top, and every rule goes to a review step before saving. Recent runs log on the right shows success, skipped and blocked-by-policy.
- **Developer Hub:** session list on the left (adapter, status pill, mono path, last activity). Detail on the right: Open folder / Stop, three facts (Sandbox, Network, Running for), a dark mono event log, and the footer note "Full transcript is stored on this Mac only".
- **Messages** (`/apps/messages`, Apps › Communicate, reference section M): three columns (sidebar, a 360 chat list, the conversation). Tabs "Needs reply · N" / All. In the list, a "Draft" chip and an unread counter. In a chat: a per-chat Auto-reply switch in the header, bubbles (incoming white, outgoing primary), and "Sent by Aelys" under messages the AI sent. Above the input, the Aelys draft card has Send / Edit / Rewrite / Skip. Send and Skip go to the next chat in the queue. Shortcuts: ⌘↵ sends, J/K switch chats. Empty queue: "All caught up".
- **Components gallery:** developer-only. It is hidden in release builds and never appears in the user app list.

## 8b. Settings
- Opens from the gear next to the profile (the profile block is highlighted). It is not a sidebar item.
- Layout: a 260 nav column (search, groups General / Assistant / System, 28 icon tiles) and a content column up to 760 wide.
- Sections: **Account** (Profile, Notifications), **General** (Appearance, Weather & location), **Assistant** (AI & models, Telegram), **System** (Connection, Security with a "macOS" badge, Data & about). Settings opens on Profile.
- Notifications: per-source switches (Task reminders, Calendar, Messages, Automation, the last one failures only) + quiet hours as a segmented control (Off / 22:00–08:00 / During focus). The "Notification settings" link in the bell leads here.
- Data & about: Export (JSON), Last synced, version + Check for updates, Reset guides.
- Pattern: a row = label (500) plus one muted line of description on the left, and the control on the right (switch / segmented / select pill). Rows are grouped in a glass card with radius 16 and separators `line-soft`. The group heading above a card is 13/600 muted.
- Changes save instantly. A Save button is only for text fields (API URL, token).
- **Wallpaper is not chosen manually.** The hero photo changes with the weather and time of day (clear / cloudy / rain / snow / night) for the city from Weather & location. Settings has no wallpaper picker or Upload.
- Telegram in Settings = connection, Auto-reply, "Reply with", Instructions, and a link to the Messages app. Conversations and drafts are never shown in Settings.
- Destructive actions (Disconnect, Sign out) are danger-soft buttons on the right, never primary.
- Secret keys show only the last 4 characters (`•••• 3f2a`) in mono.
- Reference: `Aelys Widgets & Utilities.dc.html` → section S.

## 8c. First-run guides (every app)
Every app and module that can't be understood at a glance (Automation, Messages, Developer Hub, Cards, Review, Habits, Finances) shows a **guide instead of an empty screen** on the first visit. Reference: section 4, "First visit" state.
- Structure: a 52 icon tile + a title that names the benefit ("Let Aelys handle the routine") + 1–2 sentences on what the app does. Below that, **3 steps** in soft cards (number, verb, one sentence, 1–2 example chips). Then **"Start from a template"** with 2–4 ready options and a Use button. Last, one line on how to do it yourself.
- After the first real action (a template applied, or the first item created), the guide disappears. It can be brought back with the "How it works" button in the title row (secondary, icon circle-help).
- No modal tours, no tooltip arrows over the interface, no "Next / Next / Finish" sequence.
- Settings › Data & about › "Reset guides" shows all the guides again.
- Guide copy per app:
  - Automation: When → Then → Review. Templates: Bills to tasks, Morning plan, Meeting notes, Focus after lunch.
  - Messages: Connect Telegram → Aelys drafts replies → you approve. Template: "Reply politely, never confirm money or meetings".
  - Developer Hub: Open a project → start an agent → watch and approve. Templates: claude-code / codex for a folder.
  - Cards: Make a deck → study what's due → spacing does the rest. Templates: import from a note, from CSV.

## 8d. Loading, slow and offline states
Shared component: `AelysSkeleton.dc.html` (kind = home / list / split / grid / calendar / chat / settings; `compact` for mobile).
- The page header (title + subtitle) appears immediately. Only the content area loads.
- **Up to 200ms:** show nothing (no flash). **After 200ms:** a 3px indeterminate primary bar plus a skeleton **repeating the shape of that screen** (list → rows with circles, Notes/Mail → list + document, Settings → nav + rows). Once the skeleton is shown, keep it for at least 400ms so it doesn't flicker.
- **After 2.5s:** above the skeleton, a card reading "Taking longer than usual" with the reason ("Your Aelys server is waking up") and a Retry button. The skeleton stays.
- **No network:** instead of the skeleton, "Can’t reach Aelys", one line saying local changes are kept, and a "Try again" button. No red banners at the top.
- An already-opened screen opens instantly from cache. The data refreshes in the background without a skeleton.
- Skeleton: tone `#EEE8E2` with a 1.4s shimmer. In dark mode, `#26232E`. With reduced motion, no animation. `role="status"`, `aria-busy`, hidden text "Loading Tasks…".
- Never use a full-screen spinner or a skeleton for an action inside the page (saving, a button press). For those, use the button state and a toast.

## 8e. Rich text (Notes, task description)
Shared component: `AelysRichText.dc.html`. Content is stored as HTML (sanitize on the backend: whitelist p, h1, h2, strong, em, s, code, pre, a[href], ul[data-check], ol, li[data-done], blockquote, hr, br).
- Toolbar (sticky, soft background, 32px buttons; 36px on mobile): H1, H2 | Bold, Italic, Strike, Code, Link | Bullets, Numbers, Checklist | Quote, Code block, Divider. The active one gets primary-soft + primary-deep. On mobile, Strike, Code block and Divider are hidden.
- Markdown on the fly: `#` `##` `-` `1.` `[]` `>` ```` + space. ⌘B / ⌘I / ⌘K (link), Tab / Shift+Tab inside lists.
- Checklist: an 18px checkbox with radius 6. A checked item is muted and struck through. A click on the box toggles it, a click on the text puts the caret there.
- A link opens an inline field under the toolbar (no browser prompt).
- Pasting inserts plain text with the structure kept (lists, paragraphs). External styles are stripped.
- Old plain-text notes are converted automatically: "• " → list, "[ ] / [x]" → checklist, a short line before a paragraph → H2.
- Snippets in lists and search work on plain text without tags.

## 8f. AI Chat
Shared component: `AelysChat.dc.html` (`compact` for mobile). Backend: `createAIRun` with `routing { provider_id, provider, model }` + SSE `aiRunEvents`.
- **Desktop:** three columns. Chat list (260, search, New chat ⌘N, groups Pinned / Today / Previous 7 days, a pulsing dot on a chat that is answering right now) | conversation | "What Aelys can see" + "This chat" (272).
- **Header:** chat title + a **model pill** (provider tile · model name ▾, plus a 🧠 icon when thinking is on).
- **Model picker** (popover 420 / bottom sheet on mobile): search; **Auto** at the top (Haiku for quick asks, Sonnet for planning); groups by provider with status (Connected / Not running / No API key + "Add key"). Each model row: name, one line on what it's good for, chips for context · speed · cost ($–$$), capability icons (tools, vision, thinking). Unavailable rows are 50% and can't be clicked. Footer: **Reasoning effort** as a segmented control Off / Low / Medium / High with a hint ("Balanced, ~4s"), shown only for models with thinking. When effort is on, the model pill shows the chip "🧠 Med". The "Thinking" step shows the real time ("Thought for 9s"), and the meta line ends with "· medium effort", a "Use for new chats" checkbox, and "Manage providers ›" → Settings › AI & models.
- Switching the model mid-chat inserts a divider "Switched to …".
- **Assistant reply** has no bubble: the Aelys mark plus text on the background. User message: a lilac bubble on the right.
- **Run order:** (1) three dots; (2) steps with a spinner → ✓ ("Read tasks · 6 due this week"). A source that is turned off shows as "Skipped Finances · not shared in this chat". (3) Text streams in with a violet caret. (4) After it finishes, the steps fold into "Used 3 sources ›", then the action row (Copy, Regenerate, 👍, 👎) and the meta line "Claude · Sonnet 4.5 · 3.2s · 486 tokens".
- **Action cards** in a reply (for example the day plan) have one primary action ("Add 4 blocks to calendar" → "Added to calendar ✓") and "Adjust", which puts a draft into the input.
- **Stop:** while answering, Send turns into a black ■ (Esc). What was already written stays, marked "Stopped".
- **Error:** a danger-soft card "Claude is overloaded right now · Nothing was lost" with Retry and "Try Haiku 4.5". An interrupted stream is never shown as a finished answer.
- **Composer:** an auto-growing textarea (up to 6 lines), ↵ sends, ⇧↵ makes a new line. Paperclip → a file chip above the input. A "4 sources" chip opens the source toggles. The hint "↵ send · ⇧↵ new line" shows only when the input has focus.
- **Empty chat:** the mark, "What can I help with, Tileuzhan?", a line saying what it sees ("I can see tasks, calendar, notes and mail"), and 4 suggestions.
- **Mobile:** one column. The chat list is a separate screen (icon in the header). The model pill sits under the title. The picker and sources are bottom sheets. The global AI bar is hidden on this screen.

## 9. Motion
- Standard 180ms `cubic-bezier(.2,.8,.2,1)`. Sheets 240ms. Reorder reflow 200ms.
- Delight moments: logo tap rotation + star burst (5 taps = easter egg), task star burst, "all done" celebration.
- Launch: variant C, the seamless logo move into Touch ID.
- `prefers-reduced-motion` turns all of the above into fades of 120ms or less.

## 10. Content rules
- English only, sentence case, no trailing periods in buttons or labels.
- No test, synthetic or debug strings in UI. No "demo" labels.
- Real data only. When data is missing, show an empty state, not invented numbers.
- Times are 24h `HH:MM`. Dates are `Fri, Oct 31`. Relative dates up to 7 days ("Yesterday", "Mon").
