# Component gallery

Phase 8 UI consistency slice, explicitly requested by the owner. Open
`http://127.0.0.1:5173/components`, or choose Компоненты from Settings or the login
screen. The page is a separate lazy route with local examples: buttons,
segmented selection, fields/validation, switches, cards, empty states and the
existing Aelys icon set. Its light/dark theme uses existing application tokens.
Examples do not read or mutate owner records and do not mount backend health or
authentication clients. Protected workspace routes still mount AuthGate.

## Shared switch

`apps/web/src/components/Switch.tsx` provides a controlled, accessible switch
with label, checked, disabled, pending and description properties. It resets
native button appearance, border and shadow explicitly. The track is 44×28 px
inside a 44×44 px button target; the thumb moves within it. Pending state keeps
the last confirmed value and disables repeat activation. Focus and reduced-motion
states are explicit. Touch ID and Home settings now consume this component.

The prior Touch ID button omitted the native border/appearance reset. Browser
inspection after replacement confirms `border-width: 0px` and `appearance: none`.
Native session security and preference persistence are unchanged by this visual
component replacement.

## Verification

- Full web tests: 29 files, **180 passed**. New regression coverage verifies
  controlled/pending switch behavior and isolation of the public gallery from
  owner auth/health clients, while navigating back mounts the protected app.
- TypeScript + production Vite build pass. Gallery JS is a separate lazy chunk.
- Live browser: page renders without login; switch toggles; light and dark
  themes render. Narrow viewport has no horizontal overflow (`innerWidth` and
  document `scrollWidth` both 400). The browser clamped a requested 360 viewport
  to 400; a real 360px observation is not claimed. Temporary sizing was reset.
- Screenshots: `output/components/gallery-light.png`, `gallery-dark.png`,
  `switches-light.png`, `switches-mobile.png` (last is the 400px observation).
- Current unsigned arm64 macOS `.app` rebuilt successfully: 27.51 MiB,
  executable SHA-256
  `a8f1af2027133f368631ba674a18815a92ebba69a6e56a411353686ac88f1c1a`.
  The follow-up native UI read failed with a ScreenCaptureKit capture error;
  this build's native gallery interaction is not claimed from browser evidence.
- `git diff --check` passes. No staging, commit, publication or deployment.

## Expanded selection and motion examples

The owner requested selects, multi-select, checkboxes and animations. The gallery
now adds reusable `SelectField`, `MultiSelect` and `Checkbox` controls under
`components/controls/`, and local examples for radio groups, partial/all checkbox
selection, range/progress, bounded numeric stepper, date and multiline text.
The multi-select is a nonmodal checkbox picker with search, removable chips,
disabled options, reset, outside-pointer/blur dismissal, Escape and trigger focus
restoration. Single select preserves the browser's keyboard/mobile behavior.

Feedback examples use native modal `dialog` with explicit input focus, native
Escape handling and focus returned to its opener. Notification and loading
examples clean up their timers on unmount. Finite user-triggered animations cover
card entry (500ms), dialog/notification entry, button press/hover and loading
skeleton shimmer. `prefers-reduced-motion` disables these movements. These remain
local, labelled examples, not real project creation or remote request evidence.

Validation: full web run **186 passed** across 31 test files; TypeScript and Vite
build pass. After the dialog focus refinement, the two focused feedback tests
were rerun and pass. Browser checks verify multi-select search/selection and
Escape focus restoration, native modal Escape/focus restoration and local save,
loading completion, native single-select change, checkbox group with Space, and
light/dark rendering. Narrow viewport is clamped by the browser to 400px; content
width is also 400px and the popup stays inside the horizontal viewport. The
viewport override was reset. Screenshots are `selects-multiselect.png`,
`selects-dark.png`, `multiselect-narrow.png` and `animations.png` under
`output/components/`. Native Tauri rendering of these new examples is separate
from browser verification. No backend/auth permissions, product records or
platform decisions change in this slice.

Expanded gallery macOS rebuild: unsigned arm64 `.app`, 27.51 MiB; executable
SHA-256 `4013625a51823a0c8c6589c8ee52589c73dc86cb6cc0534bd716fbfd16eaadd3`. Build passed; no native interaction
is claimed for this revision.

## Custom single-select follow-up

The owner rejected the system popup styling. `SelectField` now renders a
custom listbox using the shared theme colors, selected checkmark, active-row
highlight, chevron rotation, error/disabled states and reduced-motion support.
It retains DOM focus on the labelled combobox and exposes the highlighted row
through `aria-activedescendant`. Arrows, Home/End, Enter/Space, typeahead,
Escape/Tab and outside-pointer dismissal are handled explicitly. Highlighting
does not commit a value; disabled options cannot be selected. The popup flips
above the trigger when needed and bounds its scroll height to available space.

Checks: **189 web tests pass** (31 files); TypeScript/Vite build pass. New
selection tests cover keyboard navigation skipping disabled rows, commit vs.
cancel, typeahead and pointer/outside dismissal. The initial outside-dismiss
test dispatched the outside event before React effects attached the listener;
the test was corrected to use separate flushed user actions. Browser evidence
confirms the styled list, Home/Down/Enter selection, and Escape returning to the
unchanged combobox. Screenshot: `output/components/single-select.png`.

Single-select macOS rebuild passed: unsigned arm64 `.app`, 27.51 MiB, executable
SHA-256 `8cf501feefc04cbd9fe48c79cda81b5048229af9a8dceb79ecbbceaccb1961b7`; native GUI acceptance is not
claimed from browser checks.
