# Knowledge and grounded AI questions

Task: Phase 4 / task 4, Search + provenance + redaction. Owner approved the
readable Knowledge / editor / first RAG slice on 2026-11-01. This document records
implementation and assumptions; it does not promote unrelated OPEN decisions.

## Implemented behavior

- Notes remain canonical Markdown documents. Knowledge is a curated view of
  those documents, not a second body store. **Manage sources** explicitly enables
  a note for AI. Existing notes default to disabled. Disabling/deleting a source
  removes it from subsequent retrieval; previous answers/quoted excerpts in chats
  are retained, as the interface explains.
- The shared rich text editor supports headings, emphasis, links, lists,
  checklists, quotes, fenced code and tables. Notes and task descriptions use it;
  Knowledge, note preview and AI replies use the same safe Markdown reader.
  A Markdown source mode preserves access to the original representation.
  Unsupported syntax/embedded HTML is not a promised lossless rich-text format;
  use source mode for such documents. Raw HTML and remote image loading are not
  enabled in the reader. Attachments/image upload remain outside this slice.
- Drafts for existing notes, task edits and quick task input persist to IndexedDB,
  partitioned by browser origin, backend and owner. The UI acknowledges persistence
  only after the transaction completes and reports failures. Original server
  versions remain attached to drafts for existing conflict handling. The old
  explicit server-save behavior remains: these are local drafts, not a claim of
  complete durable server mutation replay or cross-device synchronization.
- Knowledge questions select one document, a project, or the enabled library.
  The selection is carried to a read-only AI conversation and retained on later
  questions. Clearing sources starts a fresh ordinary conversation.
- Retrieval checks owner, source consent, deletion and optional project scope on
  each question, including immediately before model execution. The policy engine
  authorizes read access. RAG conversations cannot grant write tools. No private
  Mac session tables, embeddings, mail, finance or credentials are retrieved.
- The existing BYOK harness handles model selection, budgets, cancellation and
  SSE replay. A source event precedes generation; completed assistant messages
  retain retrieved source references with note UUID, version, heading, offsets
  and a redacted excerpt. Source links open the note; a changed version is called
  out in the Notes editor. References show retrieved evidence, not an automatic
  proof that every model claim is supported. Model answers still require quality
  evaluation; they must acknowledge missing evidence.

## Search implementation and limits

PostgreSQL uses its `simple` full-text configuration and a partial GIN index on
consented, live notes. Queries use OR/prefix terms, then rank bounded paragraph
chunks. SQLite uses deterministic lexical matching on current documents. Neither
path is semantic/vector search or a claim of linguistic stemming.

Chunks are at most 1,600 characters, with paragraph-aware boundaries, 160-character
overlap and source offsets. At most six excerpts reach the model. Explicit
single-document questions may fall back to leading chunks for summary requests;
these are partial context, not a guarantee of reading an entire long document.
Library queries without matches return an insufficient-evidence answer without
calling the model. Broad queries are bounded to 100 PostgreSQL candidates or
1,000 SQLite documents and 4 million characters; an oversized SQLite/document
scope returns `KNOWLEDGE_SCOPE_TOO_LARGE` rather than silently truncating it.
Chunks are derived from current text rather than persisted separately, so stale
chunk bodies cannot survive edits/deletions. No embedding provider is called.

The next retrieval milestone is a measured evaluation set of real EN/RU/KZ
questions, followed by optional PostgreSQL/pgvector hybrid retrieval if it improves
results. Choice/location of an embedding model and any external embedding egress
remain unselected. Raw CLI sessions and their embeddings must stay on Mac.

## Contracts and migration

- Migration `0035_knowledge_consent`: boolean `notes.knowledge_enabled`, default
  false; PostgreSQL partial GIN index. Old bodies and versions are preserved.
- Note GET/POST/PATCH expose this boolean; omission in an old client's update
  preserves the current value. Consent changes use the existing version check.
- `POST /api/v1/knowledge/search`: `{query, note_ids?: string[], project_id?: string}`
  returns typed `KnowledgeSource[]`. It never invokes an LLM.
- AI conversation creation and AI run creation accept optional `knowledge` with
  the same scope (without query). Scope participates in run idempotency binding.
  `ai.knowledge.sources` sends references; unavailable consent returns
  `KNOWLEDGE_SOURCE_UNAVAILABLE` before a provider request.
- Native transport retains note organization/consent, bounded knowledge scope,
  and AI source references. Native binaries must be rebuilt to use the new DTOs.
  The search endpoint itself is a web/shared API; native question execution uses
  the existing bounded AI run operation.

## Validation and remaining acceptance

Browser QA runs against a separate disposable SQLite instance, not the owner's
working database: source reading, rich editing, note save/version increment,
reload restoring an unsaved note, task draft recovery after leaving/reopening,
question scope handoff and responsive layout. Artifacts/logs are in ignored
`output/knowledge-validation/`. Exact commands/results are reported at handoff.

A real external model completion has not been exercised with owner credentials.
Provider transport is substituted only in automated harness tests, never in the
application. No signed macOS/Android package, native offline restart, or complete
multi-device offline mutation acceptance is claimed. Local drafts are not a
collaborative merge system. Writes merge independent entries transactionally;
a stale overwrite from another tab is rejected with an explicit keep-open/copy
notice. Automatic same-document merging and a recovery-branch UI remain future
work.

The existing local service on ports 8000/5173 belongs to another checkout. It is
left running unchanged; the isolated preview uses 8005/5175. Apply migration
0035 and restart the intended backend before serving this client to real data.

### Original feature-branch verification — 2026-11-01

| Command | Observed result |
| --- | --- |
| `pnpm --filter @aelys/web test` | 51 files, 322 tests passed |
| `pnpm --filter @aelys/web build` | TypeScript project build and Vite production build passed; editor shared chunk is ~515 KB / 163 KB gzip and triggers the standard size advisory |
| `pnpm --filter @aelys/shared test` / `typecheck` | 36 tests passed; strict typecheck passed |
| `PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests` | 215 passed, 9 skipped; existing Starlette TestClient deprecation warning |
| Disposable PostgreSQL 16, `backend/tests/ai_automation/test_knowledge.py` | 5 passed, including SQLite/PostgreSQL parametrization and migrations through the original feature-branch revision 0024 |
| Final focused `test_knowledge.py` + `test_ai_security.py` after idempotency/cancellation review | 8 passed, 2 PostgreSQL cases skipped without the opt-in test URL |
| `.venv/bin/ruff check backend/app backend/tests` | Passed |
| `cargo test --manifest-path packages/native-transport/Cargo.toml --locked` | 34 passed, 2 ignored; doc tests passed |
| `cargo clippy --manifest-path packages/native-transport/Cargo.toml --locked --all-targets -- -D warnings` | Passed |
| `make openapi` with a synthetic generation key / `git diff --check` | Passed |

The full backend run's skips concern explicitly configured PostgreSQL/external
acceptance fixtures; the new Knowledge PostgreSQL cases were run separately
against a generated database in an isolated local PostgreSQL container. No owner
DB was dropped or changed. Browser measurements showed no horizontal document
overflow in the wide/narrow Knowledge layouts. Viewport overrides were reset.

### Integration with current main — 2026-11-01

Owner approved merging on 2026-11-01. Integration is based on main `051791f`;
the original feature commit is `4cbb748`. Existing main editor icon styling,
note pins, page skeletons, project colors and transcription provider support
are retained. Tiptap replaces the hand-written contenteditable implementation;
its source mode, tables and structured checklist model are shared by Notes and
Tasks. The consent migration is now `0035_knowledge_consent`, following
`0034_google_calendar`; no additional Alembic head is introduced.

Revalidation in the isolated integration checkout:

| Command | Observed result |
| --- | --- |
| `pnpm --filter @aelys/web test` | 65 files, 499 tests passed |
| `pnpm --filter @aelys/web build` | Passed; standard shared editor chunk size advisory remains (~517 KB) |
| `pnpm --filter @aelys/shared test` / `typecheck` | 37 tests passed; typecheck passed |
| `PYTHONPATH=backend python -m pytest -q backend/tests` | 865 passed, 87 explicitly configured acceptance/PostgreSQL cases skipped, one existing Starlette deprecation warning |
| Disposable PostgreSQL 16, `backend/tests/ai_automation/test_knowledge.py` | 5 passed, including the full current migration chain |
| `ruff check backend/app backend/tests` / `mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs` / `bandit -q -r backend/app -ll` | Passed |
| `alembic upgrade head` / `alembic check` against a disposable SQLite DB | Passed; no new upgrade operations; expected expression-index reflection advisory |
| `cargo test --manifest-path packages/native-transport/Cargo.toml --locked` | 34 passed, 2 ignored; doc tests passed |
| Native transport `cargo fmt -- --check` / `cargo clippy --locked --all-targets -- -D warnings` | Passed |
| `make openapi` with a synthetic generation key / conflict-marker scan / `git diff --check` | Passed |

Browser QA on a separate synthetic instance (8006/5176) confirmed the Knowledge
reader, scoped question controls, note editor with the current main styling,
interactive checklists and draft restoration after a full page reload. Existing
owner servers and databases were not migrated or restarted. Real-provider and
signed-native acceptance remain open as described above.

Telegram/main integration follow-up (2026-11-01): migration
`0037_merge_telegram_knowledge` joins this branch with
`0036_telegram_reply_media`, without changing either published predecessor.
The model's FTS index expression now uses PostgreSQL's equivalent canonical
casts, so reflection and metadata compare identically in `alembic check`.
The SQL expression/index behavior and existing consent are unchanged. See
[Telegram integration validation](optimization/telegram-main-integration.md).
