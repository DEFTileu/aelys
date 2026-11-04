# Formatted Mail reading

Task: IMPLEMENTATION_PLAN Phase 3 / task 4 (Mail read/import/drafts).
Owner requested regular email formatting and logos, 2026-11-04.

Previously Gmail/EML retained only plaintext. Store a bounded HTML alternative
(up to 1 MB) in nullable `mail_messages.body_html`, migration 0042. Return it only
from the owner-scoped message detail endpoint; list/page SQL defers the column.
The shared device cache stores details per message and invalidates them after
mail writes/sync. No new navigation-wide fetch or automatic mailbox import.

Explicit Gmail Load latest backfills HTML for previously loaded messages once,
keeps text and read state, bumps version, and creates no duplicates. EML accepts
an HTML alternative and keeps its existing owner/content-digest deduplication.

DOMPurify 3.4.17 is used because email is attacker-controlled HTML, beyond the
existing note editor's small formatting subset. Sanitized HTML is displayed in
an iframe without scripts, same-origin access, forms or top navigation. Its CSP
blocks all network by default. Inline layout/table formatting remains; stylesheet
blocks, CSS network values, active markup and unsafe URLs are removed. HTTPS
images are permitted only by the message-local Load external images action,
with a disclosure that image hosts are contacted; referrers are disabled.
Consent resets when the message changes. Parent CSP permits srcdoc frames and
HTTPS images so the narrower inner policy can enforce this per-message choice.

The formatted/text switch keeps plaintext available offline. Detail/cache errors
fall back to the already loaded text. Inline CID attachments, remote stylesheets,
fonts and full Outlook-specific rendering are outside this first slice.

Validation:

- Backend full suite: 966 passed, 93 skipped (one existing Starlette warning).
- Web full suite: 594 passed. One unrelated Notes focus assertion failed under
  concurrent compilation; the isolated Notes suite (18) and full rerun passed.
- Shared client: 75 passed; detail cache reuse, offline reads and post-sync
  invalidation covered.
- Native library: 47 passed / 2 interactive Keychain checks ignored; strict
  Clippy and rustfmt passed. Web/shared TypeScript checks passed.
- Ruff, mypy (99 source files), Bandit passed. Signed Mac release build passed.
- Browser fixture with actual sanitizer and parent CSP: table/cell styles and
  a remote logo display, script removed, parent interface intact.
- Live deployed backfill and installed-app acceptance tracked in delivery report.

No personal timetable or mailbox content is committed to the repository.
