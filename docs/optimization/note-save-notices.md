# Notes save notices — Phase 2 reliability slice

Milestone: implementation plan Phase 2, Notes offline/conflict handling. This is a bounded notice-correctness fix, not completion of the Notes module.

The parent observed in an isolated production browser that “Changes saved.” remained visible after subsequent edits and while offline. A save response now associates the notice with the returned note ID and content. It is displayed only while that note and content remain in the editor and the API is ready/online; it is discarded when these conditions cease to hold. Newer drafts still retain the returned server version as their base. Existing conflict and network-error messages remain independent of this success notice.

Assumptions: the response represents the server's saved title and Markdown body; a later editor change or selection change invalidates the notice. This slice does not change draft persistence, sync, authentication, or conflict resolution. OPEN decisions in the project register remain open; no product or architecture decision is made here.

Validation on 2026-10-30:

- `pnpm --filter @aelys/web test -- src/tests/notes-drafts.test.tsx` — passed, 25 files and 169 tests. The script forwarded the separator in a way that ran the whole web suite, rather than only the requested file.
- `pnpm --filter @aelys/web exec vitest run src/tests/notes-drafts.test.tsx` — passed, 1 file and 11 tests.
- `pnpm --filter @aelys/web typecheck` — passed (`tsc --noEmit`).

The tests use mocked API responses and jsdom; they do not establish production browser, real network, persistence, or cross-device behavior. Production build and browser QA were deliberately left to the parent; the parent-owned browser session was not operated. Next: parent production browser QA and integration, including the original offline reproduction.

## Parent production browser verification

The production build (`NotesView-C3hIA7GN.js`) was exercised through the
Playwright CLI against a fresh synthetic SQLite owner at `localhost:49821`;
the owner's ordinary `127.0.0.1` session/database was untouched. The previous
browser snapshot reproduced `Changes saved.` with an edited body and Offline
status. After rebuilding, the real API/browser sequence passed:

1. Save and reload retained the server body. Another edit immediately removed
   the success notice.
2. Browser network-offline mode disabled Save, retained the in-view draft and
   showed no success. Reconnecting, explicitly saving, then reloading retained
   that body on the server.
3. A Playwright route delayed a real PATCH (it did not mock its response). A
   newer edit typed while the request waited survived the successful response,
   without a success notice for those newer edits. Explicitly saving the newer
   draft and reloading persisted it at version 7.

All scripted assertions passed. Screenshots are
`output/playwright/note-save-notice-offline-after.png` and
`output/playwright/note-save-notice-race-after.png`; the earlier reproduction is
`output/playwright/note-stale-saved-before.png`. Full web tests: 169 pass;
typecheck and production builds pass. The isolated browser returned online.
This does not prove durable unsaved drafts across navigation/process shutdown,
offline page reload, automatic sync or cross-device behavior; those gates remain.
