# Telegram contextual sessions and application retrieval

Status: owner clarification incorporated; implementation defaults recorded below.
Task: IMPLEMENTATION_PLAN Phase 3 task 5, owner-requested Telegram extension.
Scope: Business-command sessions and curated general agent knowledge only.

## Intent

Persist bounded conversation context across explicit owner commands; start a new
session after a long idle interval; retrieve relevant application sources when
server-authorized. Keep the deployed same-message append behavior.

## Existing behavior

Business ask/search creates a fresh run with no history/tools/memory. Existing
Business rows/command jobs are encrypted and removed by retention/disconnect.
Personal bot already retains AI conversations and `/new` switches its active
conversation; automatic idle rollover is absent. Existing `personal_tools`
contains task reads, note search/read and Knowledge retrieval. Knowledge uses
owner/consent/project checks, lexical/FTS matching, bounded labelled excerpts;
`knowledge_enabled` permits AI use, not public disclosure to a contact.

## Proposed first vertical slice

- One session per owner + integration + Business connection + private chat;
  personal-bot context remains a separate audience. No cross-chat history.
- Proposed idle threshold: 60 minutes since the last accepted owner request.
  Background jobs, model completions and contact chatter do not extend it.
  Exactly at threshold a fresh session starts. Owner can reset explicitly.
- Persist assignment during ingestion with the queue/cursor, so processing
  delays, restarts, retries and concurrent polling cannot silently reassign turns.
- New `/ask` or `/search` can continue the active session. Regular Business chat
  messages alone do not invoke the assistant. Contact messages are bounded,
  same-chat untrusted reference data; current selected quote takes priority.
- Context includes bounded recent question/answer pairs and cited source refs,
  not the complete database. Session boundaries do not imply deletion; retention
  and `/new` semantics must remain distinct and be documented.
- Older sessions are excluded by default. Retrieving older context is explicit,
  same-owner/same-audience and permission checked; unlimited automatic search
  across all past chats is excluded from the first slice.
- Source retrieval uses existing typed read handlers; no arbitrary SQL exposed
  to the model. Owner/deletion/consent/version/policy checks repeat each turn.
  Revoked/deleted sources must not reappear via summaries or prior answer copies.
- Hosted search receives the explicit request, bounded same-chat command context
  and only curated shareable agent cards, through the configured provider. No
  personal-module documents are retrieved. The provider/search service may see
  this content; source curation is explicit, not a claim of perfect DLP. Public
  research evidence returns as untrusted data with actual source references.
- Owner clarified: only curated understandable Knowledge facts, e.g. Aelys uses
  Tauri and Rust. No tasks/calendar/mail/finance access, repository ingestion,
  code paths/line numbers or implementation inventories. Existing enabled notes
  additionally tagged `agent-context` are explicitly shared agent cards. A small
  built-in Aelys overview is transparent and versioned; user cards stay editable
  in existing Notes/Knowledge. No implicit permission from ordinary AI enablement.
- Knowledge source metadata is validated each turn and immediately before edit.
  Historical answers carrying stale source references are omitted. References
  from history are inherited by later answers to preserve revocation transitively.
- Reset `/new` is supported in Business command chats; no automatic idle rollover
  change to the existing private personal bot in this slice.
- BYOK/budget controls, current final source/version guards, edit receipts,
  no uncertain-send replay, encrypted storage, purge and key rotation persist.
  Raw Mac CLI transcripts and embeddings remain Mac-only.

## Approaches

1. Idle rollover plus bounded recent turns, reusing existing retrieval (recommended
   first slice): deterministic and testable, with bounded tokens and storage.
2. Topic-change detection plus idle rollover: can split a discussion incorrectly;
   add only after measured examples show the deterministic version is insufficient.
3. Unrestricted long-lived history: mixes old topics/audiences and grows cost;
   does not meet the owner's requested fresh-session behavior.

## Acceptance

- Follow-up command within 60 minutes sees only its own active chat session.
- Boundary/long-idle request starts fresh across restart and duplicate update.
- Ordinary contact text cannot trigger a command or keep a session alive.
- /new/reset and a selected quote have predictable precedence.
- Two chats and personal/business audiences never share turns or permissions.
- Knowledge revocation, note deletion and integration disconnect invalidate
  derived context; key rotation covers any new encrypted fields.
- Search receives only the selected shareable context, never personal-module documents or credentials.
- Real adapter-to-delivery tests use synthetic external I/O; live acceptance
  needs permitted messages and does not follow merely from unit test success.

Defaults selected by implementer: 60-minute idle rollover; at most 8 previous
command pairs and a bounded context pack; explicit commands only. Search is
lexical/FTS-style matching over curated facts, not new vector infrastructure.
Full archive cross-session search and topic inference remain future scope.
The private personal bot remains unchanged. Existing unrelated OPEN decisions
remain OPEN. The clarification authorizes agent-card retrieval, not personal
module access or automatic learning from chats/source code.
