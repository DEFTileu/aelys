# Navigation read optimization — main integration

Task: Phase 8, CI/E2E performance regressions and schema migration strategy.
Owner request: improve SQL/code/device caching, merge to main, build macOS and
update the existing Railway API. No OPEN product or infrastructure decision is
changed. Existing main UI, device authentication and domain sync writes are kept.

## Implementation

- Shared client: 60-second confirmed memory snapshots, 100-entry LRU, concurrent
  GET deduplication, cloned values, explicit refresh, mutation invalidation and
  owner/backend/session guards. Offline reads/replay avoid failed network attempts.
- IndexedDB: atomic response/ETag storage, cache-only reads and provisional preview
  callbacks. Storage quota errors do not hide confirmed server results. A late
  response cannot populate a replaced owner's cache.
- Notes/Mail: 50-item keyset pages, server search, load more, background refresh,
  conditional 304, preserved editor drafts and direct links outside loaded pages.
  Home requests only 10 note/mail items and shows cached previews early.
- Finance summary: PostgreSQL NUMERIC aggregation by currency; SQLite streams only
  required columns and calculates with Decimal. No binary floating-point totals.
- Migration `0039_read_path_indexes` follows `0038_ai_chat_design`. Six composite
  indexes cover owner/project task filters and chronological finance, mail,
  activity, history and notification reads. Upgrade/downgrade preserve records.
- Native operations keep typed resource/query bounds, response field allowlists,
  and the existing device/session permission checks. Note pin/update timestamps
  and mail read/version fields survive page sanitization.

## Measurement

Fresh synthetic SQLite database, 2,000 notes and messages with ~8 KB bodies,
one warmup and five repetitions, in-process ASGI (not internet/Railway latency).
Full raw results: [paged-reads-main-sqlite.json](paged-reads-main-sqlite.json).

| Read | Full collection bytes | First 50 items bytes | Unchanged bytes |
| --- | ---: | ---: | ---: |
| Notes | 16,492,891 | 412,748 | 0 (304) |
| Mail | 16,626,891 | 416,159 | 0 (304) |

The first page transfers about 40 times less data in this fixture. These numbers
are synthetic and do not establish a production latency guarantee. Scripts reject
nonempty databases; benchmarks must use disposable synthetic databases only.

## Limits

Existing full-list callers outside Notes/Mail/Home remain compatible; task/finance
pagination and push-driven refresh are future work. Notes facets read all label
metadata and substring search still scans eligible text. A first uncached launch
still needs a server connection. SQLite storage and macOS signing/notarization
retain their existing product decisions; this task adds no provider or SDK.

Validation commands and exact results are recorded in the integration PR.
