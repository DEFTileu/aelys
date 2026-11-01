# Aelys Design System

Source of truth for every Aelys surface (web, macOS, Android). Reference designs (kept in the Claude Design project):

- `ACTUAL Aelys Desktop.dc.html`: shell, Home, all modules
- `ACTUAL Aelys Mobile.dc.html`: mobile adaptation
- `AelysLaunch_ACTUAL.dc.html`: launch animation (variant C) and unlock
- `Aelys Widgets & Utilities.dc.html`: widget sizes, Customize, Timer, Automation, Developer Hub

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
`assets/aelys-dark.css` (in the design project) maps every light literal to its dark value. Use only the literals listed above so the mapping keeps working. Main dark values: canvas `#141219`, surface `#201D28`, soft `#2A2733`, line `#34303D`, ink `#F1EEF6`, muted `#A6A0B2`, primary text `#B9A8FF`.

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
- Top-right cluster: search pill (⌘K), theme, notifications. There is no weather pill in the header.
- Home hero is 220–280 tall: photo with a gradient into the canvas, and the composer sits on the boundary. Module pages use the plain canvas with no photo.
- Mobile: header with logo, search, notifications and avatar (max 3 icons). No bottom nav. The AI bar is pinned at the bottom of Home, and page content gets bottom padding equal to its height so nothing hides under it.

## 8. Utilities
- **Timer:** the page title "Focus" with a segmented Focus / Break / Stopwatch control. A 320 ring with a 72px time, preset chips (25/50/90), a linked task pill, a coral Start/Pause (the only primary) and Reset. Right column: Today total + session bars, Sessions list, This week bars. No selects.
- **Automation:** each rule card reads as a sentence: **When** [trigger chip] → **Then** [action chip], plus policy chip, last run and switch on the row. An AI "Describe a rule" input sits on top, and every rule goes to a review step before saving. Recent runs log on the right shows success, skipped and blocked-by-policy.
- **Developer Hub:** session list on the left (adapter, status pill, mono path, last activity). Detail on the right: Open folder / Stop, three facts (Sandbox, Network, Running for), a dark mono event log, and the footer note "Full transcript is stored on this Mac only".
- **Components gallery:** developer-only. It is hidden in release builds and never appears in the user app list.

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
