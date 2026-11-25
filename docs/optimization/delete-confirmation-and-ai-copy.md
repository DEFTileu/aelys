# Delete confirmation and AI copy — task notes

Scope: Phase 2, task 3 (Notes and Tasks CRUD), with the owner-requested project deletion and AI copy corrections in the existing frontend. This is a targeted repair, not a milestone completion claim.

Assumptions: project and note deletion retain their existing API and related-data semantics. The in-app confirmation is shared across desktop and mobile, and a failed request keeps the target and any note draft available. No product decision or OPEN question is resolved by this repair.

Validation: `pnpm test` (105 files, 1041 tests); `pnpm typecheck`; `pnpm build`; targeted delete and clipboard regression tests, including desktop/mobile, keyboard, cancellation, failure and repeated submission. The production build reports existing chunk-size and mixed dynamic/static import warnings.

Native acceptance remains open: rebuild the macOS application and exercise cancellation and confirmation with disposable data. Opening external Apps links and saving Telegram media depend on native WebView behavior and were not verified on a live device; no new native permissions were added. Do not use real data for this validation.
