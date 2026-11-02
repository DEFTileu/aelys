# Mobile parity brief (working note)

Goal: the phone UI (web app at widths <= 700px, used by the Tauri Android app) must match the
Claude Design reference **`ACTUAL Aelys Mobile.dc.html`** exactly: sizes, spacing, fonts, colours,
radii, shadows, behaviour, light and dark. Features that exist in the app but not in the design
stay, restyled in the design's visual language.

Reference copy (read the code, do not eyeball screenshots; inline styles hold the exact values):
`/private/tmp/claude-501/-Users-tileuzhan-vsCode-aelys/4c770f1f-f7cf-46a2-b77f-7216aec22b18/scratchpad/design/ACTUAL-Mobile.dc.html`
(+ `support.js`, `assets/`). Design tokens/rules: `docs/DESIGN_SYSTEM.md` (the design file wins on conflict).
The design's screen list: Home, Tasks, Calendar, Projects, Notes, Mail, Finances, AI Chat,
Notifications, Search, Settings, Customize home. The desktop reference is `ACTUAL-Desktop.dc.html`
in the same folder (already implemented; reuse its tokens/components where the mobile design reuses them).

Rules:
- Mobile-only changes go in `@media (max-width: 700px)` blocks (or the existing mobile shell) so the
  desktop layout stays untouched. Match the surrounding code's naming and CSS idiom.
- Keep every existing behaviour and test passing (`pnpm --filter @aelys/web exec vitest run`, `tsc --noEmit`).
- Several agents work in this one worktree at once: edit only the files you own, commit only those
  with explicit `git add <paths>` (never `git add -A`, stash, reset or checkout of others' files),
  Conventional Commit messages, end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not touch `packages/native-transport`, backend, or auth code.
- Report: what matched, what you could not match and why, files changed.
