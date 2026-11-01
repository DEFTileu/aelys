# Telegram composition integration into main

Owner requested merging this task into main and auditing remaining local work on
2026-11-01. Task remains Phase 3 / Telegram commands and verified binding.

Inputs: main e40e7fb, Telegram commits 608d196 / 8ac1198 / 682c76f. Independent
chat messages, optional explicit quotes, received photo/voice/audio viewing and
borderless mobile input behavior are retained. Current main Knowledge/Notes and
weather wallpaper changes are preserved; no feature scope or OPEN decision is
changed. Documentation conflicts retain both contracts. OpenAPI is regenerated
from the combined application, not hand-merged.

Migration 0037_merge_telegram_knowledge joins 0036_telegram_reply_media and
0035_knowledge_consent. It is a no-op merge revision: published migration IDs are
not renamed or reparented. Tests reproduce each actual preceding schema, upgrade
to one head, preserve note bodies/versions and existing consent, default old notes
to disabled, and check that Telegram receipt/media fields exist. Existing 0034
and pre-media upgrade/downgrade tests also pass. Run normal `alembic upgrade head`
on a deployment before using the combined server.

Other local work is left intact:

- The old local main checkout has 104 staged UI/design changes, including
  deletion of Messages, Apps and existing editor files. These are unrelated to
  this task and were not committed or applied. Its branch/check-out/index must
  not be reset to refresh a server.
- The knowledge-rag checkout has 15 modified/untracked entries: Railway/temp
  deployment config, Docker/config/cert/test work and project/goal documents.
- The design prototype checkout has an untracked apps/ design-prototype tree.
- Historical feature commit 4cbb748 is not an ancestor of main but was already
  ported as a560f42, with current main compatibility and migration naming. It is
  not an additional pending Knowledge implementation. All other local branch
  tips were ancestors of origin/main when this audit started.

No unrelated working-copy content, real credentials/database, actual Telegram
send, provider request or owner-server restart is part of this integration.
Remote main can be advanced from this clean integration checkout while the old
local main checkout and its running service remain untouched.

PostgreSQL check additionally exposed existing Knowledge index reflection drift:
PostgreSQL deparses implicit casts in the FTS expression, while metadata omitted
them. The model now spells the same expression in canonical form. No index or
query behavior change is needed; mounted PostgreSQL `alembic check` passes after
this adjustment. The original expression made the check fail with a false
remove/add-index proposal before the adjustment.

## Final validation

- Full backend `make test`, with disposable PostgreSQL AI contracts and an empty
  PostgreSQL migration DB: **994 passed, 2 skipped, 1 warning in 280.65s**.
  The two mounted PostgreSQL contracts were run separately: **2 passed, 2.14s**.
  Existing warning concerns Starlette/httpx; pytest-asyncio also reports its
  existing unset default loop-scope configuration at startup.
- Actual legacy Telegram and Knowledge/merged upgrade tests: **5 passed**;
  final rerun of the both-branch merge and old-note consent tests: **3 passed**.
  SQLite and PostgreSQL upgrades/check pass; one head 0037. PostgreSQL check
  reproduces the former reflection mismatch before the model fix and succeeds
  after it. Existing note body/version and opt-in are preserved.
- Web **539 tests / 68 files** and production build passed. Shared **43 tests**
  and typecheck passed. The existing editor chunk-size advisory remains.
- Native transport `cargo test --manifest-path packages/native-transport/Cargo.toml
  --locked`: **34 passed, 2 ignored**; doc tests passed.
- Ruff, mypy (**95 source files**), Bandit, compileall, runtime OpenAPI equality,
  conflict-marker and diff checks passed. pip-audit reports **no known
  vulnerabilities**; the local unpublished backend package is not PyPI-auditable.
- Real Telegram/provider delivery and signed native packages are not revalidated
  by this integration; no owner database/service was migrated or restarted.
