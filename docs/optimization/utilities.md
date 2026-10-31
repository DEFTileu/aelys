# Local Utilities

Selected task: Implementation Plan Phase 3, task 6. Owner requested a password
generator and encoders/decoders, then asked to publish the revised preview in
main on 2026-10-31. The slice reuses the existing AppShell, Settings panels,
Switch, SegmentedTabs, shared buttons and theme tokens. It starts from the
current origin/main so newer device-key authentication remains intact.

## Scope and assumptions

- `/utilities` is a lazy protected route, reachable from desktop navigation,
  mobile All apps, and the command palette. No AuthGate exceptions.
- Password length 8–64, selectable uppercase/lowercase/digits/symbols, at least
  one character from every chosen group. Web Crypto rejection sampling avoids
  modulo bias; unavailable randomness or invalid settings clears the result
  and disables copying. Changing settings regenerates the password.
- UTF-8 standard padded Base64 (canonical bits checked), URL component encoding
  (plus remains plus when decoding), basic HTML entities and numeric references,
  and Unicode escapes including supplementary characters and UTF-16 pairs.
- Input is limited to 65,536 UTF-16 code units. Oversized pastes and malformed
  input show fixed errors without exposing input in messages. Output may grow;
  reversing an output beyond the input limit reports an error.
- Inputs/results stay in view memory. No history, API, DB, outbox, storage, AI
  context, SDK, or migrations. Clipboard writes require an explicit click and
  report failure; clipboard contents remain subject to OS clipboard behavior.
- Decoded HTML remains textarea text. No HTML parsing, eval, or execution.
- Further codecs, passphrases and a password vault remain OPEN. No unrelated
  product decisions changed. ADR-026 avoids the ADR-025 already used for auth.

## Validation

- `pnpm install --frozen-lockfile`: passed, existing lockfile unchanged.
- `pnpm --filter @aelys/web exec vitest run src/tests/utilities.test.ts
  src/tests/utilities-view.test.tsx src/tests/router.test.ts
  src/tests/mobile-shell.test.tsx src/tests/app-routing.test.tsx`:
  **5 files, 53 tests passed**.
- `pnpm --filter @aelys/web test`: **53 files, 365 tests passed** after rebasing onto the updated main
  (initial main snapshot: 51 files, 332 passed).
- `pnpm --filter @aelys/web typecheck`: passed.
- `pnpm --filter @aelys/web build`: passed (`tsc -b && vite build`).
- `git diff --check`: passed. No separate web lint script exists. Backend,
  Rust and DB tests were not run: this slice changes no server/native code.
- Isolated local browser QA rendered production AppShell + UtilitiesView,
  with no owner records, auth grants or bypass added to the app. Generator,
  Base64 encode/reverse with Cyrillic and emoji, light/dark appearance and
  mobile layout checked. At measured CSS width 320, document width and scroll
  width both equal 320. No browser console errors. Screenshots and the QA
  harness remain ignored under `output/utilities-qa/`. AuthGate and lazy route
  behavior are covered by routing tests; the QA harness is not an authenticated
  end-to-end or native-device acceptance claim.

## Limits and next task

This adds shared web-client functionality; no installed macOS app or Android
APK was rebuilt and no hosted deployment was performed. Next: native Web Crypto
and clipboard smoke tests in packaged development builds.
