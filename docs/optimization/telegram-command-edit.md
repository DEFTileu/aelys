# Telegram owner command edit — 2026-11-13

IMPLEMENTATION_PLAN Phase 3 task 5, owner-requested follow-up to ask/search.

The owner demonstrated successful live search and requested appending the answer
to their question via edit. Commands now retain the exact source text and append
an answer/sources with a blank line. Only the original owner command is edited,
never the quoted contact message. Reply/selected-quote identity is retained by
editing the same remote message. No schema or dependency changes.

Every command remains a separate run with the configured provider/model, without
personal tools, memory, unrelated chat history or previous-command history. The
prompt explicitly forbids inviting follow-up or suggesting unrelated meanings.
This is prompting, not a guarantee of every future model's wording. A new explicit
command can supply a clarification or selected quote; ordinary chat text does not
continue an ask/search session.

Delivery retains the server Policy Engine and durable receipt boundary. Edit
identity is included in the receipt fingerprint. Owner provenance, source version,
text-only target, fresh connection/can_reply, inbound-last-24h and source-age-48h
are checked; the source is checked again just before remote I/O. Unknown outcomes
never replay or fall back to a separate customer-facing send. Stored newer owner
edits/deletions, disconnects and observed permission revocation during I/O are
preserved, even though Telegram cannot condition an edit on a remote version.
The complete question+answer must fit 4096 characters or a private notice is sent.

Assumptions: keep the visible slash command above the answer exactly as requested;
no new conversational continuation or session memory is approved by this change.
Existing privacy, consent and OPEN decisions remain unchanged. No live test
messages were sent from the owner account during development.

Validation in progress: baseline command+manual send 44 passed; initial new
behavior RED 12 failed/21 passed, then GREEN command+manual send 51 passed.
Concurrent state tests RED 3 failed/37 passed exposed stale ORM reads; explicit
refresh and post-I/O authority checks fixed them. Final focused command/manual
send/transport suite: 79 passed. Ruff, mypy (126 files), Bandit and diff check
passed. The first complete backend snapshot passed 1466 tests with 118 skipped in
163.87 seconds. Independent review found a later read-to-commit deletion race:
a reproducing test failed before the fix. Persistence now uses an atomic
version/deleted-at conditional update; the focused suite passed 80 tests.
Final complete backend rerun after the atomic fix: **1467 passed, 118 skipped**
in 175.82 seconds. Existing Starlette/httpx deprecation warning remains. Ruff,
mypy (126 files), Bandit and whitespace checks passed on the final code. No new
migration; existing startup `alembic upgrade head` remains sufficient.
