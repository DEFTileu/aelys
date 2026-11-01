# Aelys Design System

Source of truth for every Aelys surface (web, macOS, Android). Reference designs (kept in the Claude Design project):

- `ACTUAL Aelys Desktop.dc.html`: shell, Home, all modules
- `ACTUAL Aelys Mobile.dc.html`: mobile adaptation
- `AelysLaunch_ACTUAL.dc.html`: launch animation (variant C) and unlock
- `Aelys Widgets & Utilities.dc.html`: widget sizes, Customize, Timer, Automation, Developer Hub

If code and this file disagree, this file wins. If this file and a reference design disagree, the reference design wins.

---

## 1. Principles

1. **Calm, not empty.** Content goes on soft glass cards over a warm beige canvas. The photo appears in the page hero band (Home 420 tall, desktop module pages 230), the Weather card and the launch/unlock screens.
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
`assets/aelys-dark.css` (in the design project) maps every light literal to its dark value. Use only the literals listed above so the mapping keeps working. Main dark values: canvas `#141219`, surface `#201D28`, soft `#2A2733`, line `#34303D`, ink `#F1EEF6`, ink-2 `#CBC6D5`, muted `#A6A0B2`, primary text `#B9A8FF`, sidebar `#18161E`. Glass cards are `rgba(32,29,40,.86)` with a `rgba(255,255,255,.08)` edge; the Weather photo card keeps its light edge.

## 3. Typography
Font: **Inter** (bundled locally), tabular numerals on, optical sizing off so large text keeps the widths of the reference's static Inter. Mono: **JetBrains Mono**, used only for paths, logs and code.

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
- Card shadow: `0 8px 24px rgba(40,30,30,.07)` (measured in the reference). Popover: `0 18px 50px rgba(20,10,30,.22)`. Modal: `0 30px 80px rgba(20,10,30,.3)`.
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
- Desktop: `repeat(4, minmax(0,1fr))`, gap **16**, `align-items: start`, rows size to their content. At 1440 a column is 271.25 wide. The 264 and 544 figures below are **minimum heights**, not fixed cells: a card grows only when its content needs it (for example Focus is 268 tall). Below 1240px: 2 columns. Below 900px: 1 column and the sidebar narrows to 200.
- Mobile: 2 columns, cell = (viewport − 32 − 12) / 2, gap 12.

### Sizes (the only sizes that exist)
| Size | Cells | Desktop min height | Purpose |
|---|---|---|---|
| S | 1×1 | 264 | The reference card: one column of content |
| M | 2×1 | 264 | The same content across two columns |
| L | 2×2 | 544 | M plus more rows and extras |
| Tall | 1×2 | 544 | S plus more rows |
| Full | 4×1 | auto | Recent activity only: one row of four tiles |

**Content follows the reference.** S and Tall draw one column, M and L two (Full draws four). L and Tall add rows and the extras the reference does not have:

- **Today:** up to five tasks (eleven on L and Tall) with checkboxes; L and Tall add a quick-add field. Overdue tasks are included, finished ones stay until the day ends.
- **Calendar:** today's events as tinted bars; L adds the month grid, Tall lists eight events.
- **Focus:** the ring with Start/Pause/Resume, Stop and a shortcut to Timer; M and L put the ring and controls side by side; L and Tall add the linked task, today's total and the week bars.
- **Weather (photo card):** conditions plus four forecast columns; L and Tall add the five-day list. With no location set it shows one "Set location" button.
- **Projects:** three projects with a progress bar (eight on L and Tall).
- **Notes and Knowledge base:** four latest notes (ten on L and Tall); pinned notes come first on L.
- **Finances:** balance, the change this week, seven bars and the top expense categories; L adds the budget. Currencies are never summed.
- **Mail:** latest unread messages with the unread count in the heading.
- **Recent activity:** the latest events as tiles (four across on Full).

### Rules
- Size is **only** what the user picked. There is **no Auto sizing**: a card must not grow because a record was added.
- The default layout is the reference: Today, Calendar, Focus, Weather, Projects, Notes, Finances and Knowledge base at S, then Recent activity at Full. Mail is available from Customize. A stored copy of the previous default follows this one.
- Empty state is one muted line plus one action. A widget never shows an error paragraph; show "Can't load · Retry".

### Customize
- Enter with the "Customize" button or a long-press (mobile). Exit with Done or Esc.
- **Move:** drag the card body. Other cards reflow, and the drop target shows a dashed primary outline.
- **Resize:** drag the bottom-right corner. It snaps to S/M/L/Tall with a live outline and a size badge.
- **Remove:** tap the × badge at top-right.
- **Add:** the "Add widget" sheet. Pick a widget on the left and a size preview on the right (default M), then press Add.
- **Keyboard:** arrows move, Shift+arrows resize, Delete removes.
- **Banned:** ↑/↓ buttons, size dropdowns, "Auto", per-card toolbars, form-based Customize on mobile.
- Edit mode draws a 1.5px dashed primary outline, a move icon in place of the icon tile, a round × at the top right and the resize handle in the bottom-right corner. Bodies are inert but keep full contrast. Changes save instantly.

## 7. Shell
- Sidebar 240 (200 below 900px): logo block on top, nav, profile at the bottom. Nav item height 42, radius 12, 20px icons, 24 × 20 count badge. The profile shows the signed-in owner's name and email; a neutral fallback is used when there is no usable name. The active item gets a primary-soft fill and primary-deep text.
- Top-right cluster: search pill (⌘K), theme, notifications. ⌘1 to ⌘9 open the first nine pages, as the command palette shows. There is no weather pill in the header.
- Home hero is 276 tall (56 top padding): date, 36/44 greeting and the sub line over a 420 tall photo that fades into the canvas, with the composer on the boundary. The greeting uses the owner's name, or "there". Desktop module pages show a 230 tall photo band with the date, a white 30/38 title and a subtitle, then the plain canvas.
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
