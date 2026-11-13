# Telegram contextual sessions and agent Knowledge — 2026-11-13

Task: IMPLEMENTATION_PLAN Phase3/task5, owner-requested extension. Owner clarified
Knowledge means readable general facts, such as Aelys purpose and Tauri/Rust
stack, not private modules or code/path/line inventories. No UI redesign.

## Implementation and defaults

Migration0054 adds session_id, encrypted answer and provenance refs to the existing
command queue. Legacy rows do not gain guessed history. Assignment is atomic with
command ingestion/cursor and integration lock. Idle threshold is an implementer
60-minute default measured from accepted owner command timestamps, with a fresh
session exactly at the boundary. Same owner/integration/connection/chat only.
/new explicitly resets. Ordinary chat does not invoke commands or extend expiry.
Personal bot sessions remain unchanged. Cross-session archive search/topic
inference remain outside this first slice.

Context selects up to 8 recent successful turns, bounded to12000 characters,
prioritizing newer turns. Current selected quote is separately untrusted and
current-question instructions take priority. Stored automatic answers are not
verified factual evidence. Context refs are bounded and inherited transitively.
Deleted/changed turns and revoked/changed cards invalidate derived context.
Before provider execution and immediately before edit, refs/versions are checked.
Existing final edit source checks, receipt/idempotency and no replay survive.

Knowledge reuses canonical notes: exact agent-context tag AND knowledge_enabled
opt into shareable cards. No personal task/calendar/mail/finance tools, source
files, Mac CLI transcripts or embeddings are accessed. A transparent Aelys
built-in narrative card is included only for project-name queries. Owners edit
cards in existing Notes/Knowledge; see AGENT_KNOWLEDGE.md. No automatic learning
or repository indexing. Detection of private/code-like content is curation,
not a perfect semantic classifier. Explicit cards and same-chat context may
reach the selected BYOK provider and hosted search. Retrieval is bounded lexical
matching (6x1600-char excerpts, 100 candidate notes/4MB), not semantic search.

Answer/query/quote encryption, key rotation, immediate deletion/revoke wipes and
7-day retention apply. /new changes active context, not retention. Published
Telegram messages/old app chat records are not retroactively retracted by source
revocation. No production test messages sent from the owner account.

## Verification

Initial new session tests RED:7failed (missing persistence/session behavior).
Integration session/command/parser snapshot GREEN:87passed. Further quote,
long-session and provenance tests, migration and rotation suites are included
in final validation recorded at release. The initial complete backend snapshot passed1492tests/126skipped in260.94s.
Independent review found two issues: inherited refs beyond the six-result search
limit and context revoked during remote I/O being persisted afterward. Both had
failing reproductions; validation now accepts the bounded inherited set and
rechecks context after delivery before storing a usable answer. A confirmed edit
whose context changes is privately reported as already published, not as unsent.
Focused session+Knowledge after fixes:23passed/8PostgreSQLskipped. Migration and
rotation:18passed. Final full rerun follows these fixes; no live messages sent.

Final snapshot after review fixes and incoming main integration: **1496 passed,
126 skipped** in207.63s; PostgreSQL opt-in cases account for some skips. Ruff,
mypy128files, Bandit, compileall and diffcheck passed. Existing Starlette/httpx
deprecation warning remains. Full production acceptance is not claimed by tests.
Release includes0054migration; startup Alembic applies it before backend serving.
