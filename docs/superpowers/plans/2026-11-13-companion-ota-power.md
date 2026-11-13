# Aelys Companion — OTA, crash dumps, power and CI (plan 4 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board updates itself over the air from the owner's signed releases and rolls back on its own if a release is bad, sends its crash dumps to the backend, lasts on battery (screen dims and turns off, face-down turns it off, light sleep between frames), and every push builds the firmware and runs its host tests in CI.

**Architecture:** Firmware images are stored in Postgres (as `ai_attachments` already stores image bytes), served by the existing Railway backend to the board over its normal HTTPS + Bearer, and uploaded only through a new narrow command of the owner's Mac CLI. Images are signed with RSA-3072 on the owner's Mac (`CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT`, no eFuse); the board's `esp_https_ota` checks the signature, and the app marks itself valid only after a working channel session. Power is a pure-C state machine (`components/logic`) driven by touch, buttons and the QMI8658, plus `esp_pm` DFS + auto light sleep with PM locks held by `ui` only while it draws.

**Tech Stack:** ESP-IDF v6.1 (`esp_https_ota`, `app_update`, `espcoredump`, `esp_pm`), C11, LVGL 9.6.0, `espsecure`; FastAPI, SQLAlchemy async, Alembic, pytest; Rust (`packages/native-transport` CLI); GitHub Actions with `espressif/esp-idf-ci-action`.

**Spec:** `docs/superpowers/specs/2026-11-12-esp32-companion-design.md` §4.4 item 6, §4.6 (power, reliability), §4.7, §4.8, §4.9 phase 4, §4.10. Builds on plan 1 (`firmware/companion/`, results in `firmware/companion/docs/budgets.md`, carry-over in `firmware/companion/docs/next-steps.md`), plan 2 (`backend/app/companion/`, contract `docs/companion-protocol.md`, ADR-029) and plan 3 (firmware `link` component: login, channel, `hello`; written in parallel — where this plan names a plan 3 function, use plan 3's actual name and say so in the report).

**Out of scope:** an on-screen "Updating…" view (UI design needs an owner mock-up, AGENTS.md); NVS encryption, Secure Boot, anti-rollback eFuses (spec §4.8 — never in this plan); a firmware page in the app; reporting OTA failures to the backend (the next `hello.fw_version` shows the outcome).

## Global Constraints

- Firmware: ESP-IDF **v6.1**, C11, no C++/Arduino/cJSON/BLE; only the `ui` task calls LVGL; no malloc, locks or logs in the render path; `sdkconfig` never committed (only `sdkconfig.defaults`).
- Signing: `CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT=y`, `CONFIG_SECURE_SIGNED_APPS_RSA_SCHEME=y` (ESP32-S3 supports RSA only), `CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT=y`, `CONFIG_SECURE_BOOT_BUILD_SIGNED_BINARIES=n` (CI builds unsigned; the owner's Mac signs). The private key lives only at `$AELYS_FW_SIGNING_KEY` (default `~/.aelys/companion-signing-key.pem`, mode 0400) on the owner's Mac — never in the repo, CI, a log, a commit, or an agent's tool output. Only the owner runs the signing step.
- **Once signing is on, an unsigned app aborts at boot** (IDF: the running app checks its own signature block). Every USB flash after Task 8 goes through `tools/flash_signed.py`; no plain `idf.py flash` of the app.
- **No eFuse command, no `erase-flash`, never delete `~/aelys-backups/companion/`** — each needs a fresh explicit yes from the owner. Routine app/OTA-partition and bootloader flashing is approved.
- Board: one USB port, shared with plan 3. Tasks marked **board: yes** run strictly one at a time across both plans; if `/dev/cu.usbmodem*` is missing, stop and ask the owner to plug it in. Serial via `tools/serlog.py` (env `PORT`, default `/dev/cu.usbmodem1101`).
- Repo is PUBLIC: owner contacts only in git-ignored `main/owner_contact.local.h`; CI copies `owner_contact.example.h` instead.
- Backend: every route under `/api/v1`; errors `HTTPException(status, detail={"code","message"})`; no new services, vendors or buckets. New codes: `FIRMWARE_INVALID` (422), `FIRMWARE_UNSIGNED` (422), `FIRMWARE_HASH_MISMATCH` (422), `FIRMWARE_EXISTS` (409), `FIRMWARE_TOO_LARGE` (413), `FIRMWARE_NONE` (404), `COREDUMP_TOO_LARGE` (413); reused from plan 2 / existing code: `DEVICE_SCOPE_DENIED` (403), `COMPANION_ONLY` (403), `NOT_FOUND` (404), `VALIDATION_ERROR` (422).
- Migration `backend/alembic/versions/0055_companion_firmware.py`, `down_revision = "0054_telegram_command_sessions"`, inspector-guarded like `0024_device_pairing.py`.
- Size limits: image ≤ 4 194 304 B (`ota_0`/`ota_1` are 0x400000); core dump ≤ 65 536 B (`coredump` partition 0x10000). Bodies are read with a running cap, never `await request.body()` unbounded.
- Versions are `MAJOR.MINOR.PATCH` integers (regex `^\d{1,3}\.\d{1,3}\.\d{1,3}$`), set once in `firmware/companion/CMakeLists.txt` as `PROJECT_VER`; the board reads `esp_app_get_description()->version`.
- One TLS session at a time on the board (internal heap dips to 62 KB, `budgets.md`): OTA download and core-dump upload never run while the channel socket is open.
- Backend validation before each commit: `PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests/<file>`; `.venv/bin/ruff check backend/app backend/tests`; `.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs`; `.venv/bin/bandit -q -r backend/app -ll`; schema: `cd backend && PYTHONPATH=. ../.venv/bin/alembic upgrade head && PYTHONPATH=. ../.venv/bin/alembic check`; routes: `make openapi`, commit `docs/openapi.json`. Firmware before each commit: `idf.py build` in `firmware/companion` and `cmake -S firmware/companion/sim -B firmware/companion/sim/build && cmake --build firmware/companion/sim/build && ctest --test-dir firmware/companion/sim/build`.
- Git: branch `feat/companion-ota-power` in a worktree (`.worktrees/companion-ota-power`), copy the git-ignored `owner_contact.local.h` in; Conventional Commits; stage explicit paths only. Merge to `main` before any release build — releases are built only from fresh `main`.

## Integration checkpoint (2026-11-14)

Main now includes `0051_companion_v11` and Telegram migrations 0052–0054.
OTA uses the next free revision `0055_companion_firmware`, after
`0054_telegram_command_sessions`; the handoff's suggested 0052 is stale.
ADR-030 remains PROPOSED. Signing, board OTA integration and owner-held key
setup require the owner's decision/presence; this integration does not enable
signed-app checks or modify the installed board image.

Integration validation on `codex/companion-ota-sync`: full backend 1535 passed,
127 skipped; explicit PostgreSQL 16 clean and paired-state migration tests
2 passed; host simulator 24/24; native transport 119 passed, 2 ignored;
ruff, mypy (131 source files), bandit and actionlint passed. OpenAPI regenerated.
Normal ESP-IDF build passed: 1541546 B image, 158714 B linked DIRAM.
The migration regression covers the real pre-OTA schema, retained key/settings,
binary storage, guarded replay and downgrade/re-upgrade on SQLite and PostgreSQL.

A confirmation deadline bug found during integration is fixed: a still-pending
release rolls back when its last success event arrives at or after the deadline.
The regression checks all three possible last events before/at/after the limit,
including 32-bit clock wrap; already-valid firmware remains valid. Both the
whole-branch review and scoped deadline-fix review found no remaining blocker.
This is integration readiness, **not** completed OTA/power acceptance: tasks
8–12 and 15 still require board integration/checks; no OTA deployment or signing
configuration was performed. Preserve this worktree until those tasks are done.

## Review Focus

1. **A release rolls back (never confirms or crashes), and the server keeps offering it** → the board remembers the bad version and never installs it again; only a strictly higher version is tried. No update loop. (Task 6 `test_bad_version_never_retried`; Task 9 Step 4.)
2. **A stolen companion token on the upload route or another board's firmware** → 403 `DEVICE_SCOPE_DENIED`; the board can only read its own `/devices/{id}/firmware`. (Task 2.)
3. **Metadata that points elsewhere** (absolute `url`, `http://`, another host, size > slot, running version < `min_version`) → the board refuses before opening a connection. (Task 6.)
4. **Board lying face-down while someone taps the table or a notification arrives** → screen stays off; button or lift wakes it; the two-button ICE hold still works with the screen off. (Task 7 `test_touch_ignored_face_down`; Task 11 Step 4.)
5. **Board powers off mid-download, or the dump upload fails** → old app keeps running; the dump stays in flash and is sent on the next connect; the same dump sent twice is stored once. (Task 4 `test_same_dump_stored_once`; Task 9 Step 4; Task 10 Step 3.)

---

## Lanes and order

| Lane | Tasks | Can start |
|---|---|---|
| A — no board, now | 5, 6, 7, 14 | now (pure C + CI; no dependency on plans 2/3) |
| B — backend | 1 → 2 → 3, 4; then 13 | after plan 2 is merged to `main` (they edit `backend/app/companion/*`) |
| C — board, strictly sequential, shared with plan 3 | 11 → 12 → 8 → 9 → 10 → 15 | 11, 12: any time the board is free. 8: after plan 3's last board task (signing changes how everyone flashes) **or** with plan 3's controller agreeing to switch to `tools/flash_signed.py`. 9, 10: after Lane B is merged and deployed to Railway and plan 3's link works on the board. |

---

### Task 1: Protocol v2 and ADR-030 — model: **haiku** · board: no · after plan 2 merged

**Files:** Modify `docs/companion-protocol.md`, `docs/DECISIONS.md`.

- [ ] **Step 1:** In `docs/companion-protocol.md` change the title to v2 and add, keeping everything else unchanged:
  - server → board `ota_available {version}` — sent after `hello` when a newer release exists and the board's `fw_version` ≥ its `min_version`, and to online boards right after an upload. Example `{"type": "ota_available", "version": "0.3.0"}`. The board then calls `GET /api/v1/devices/{device_id}/firmware`.
  - `metrics` gains two optional fields: `light_sleep_pct` (int 0–100, share of the last period spent in light sleep) and `ui_wakes_per_s` (int). Old boards may omit them.
  - HTTP section: `GET /api/v1/devices/{device_id}/firmware` → `{version, url, sha256, size, min_version}` (`url` is a path starting with `/api/v1/companion/firmware/`, joined by the board with its own API base); `GET {url}` → `application/octet-stream`; `POST /api/v1/companion/coredumps` (raw body, headers `X-Fw-Version`, optional `X-Elf-Sha256`) → `{id}`.
  - Replace the note "Firmware OTA is not part of v1 (plan 4)" with the rollback rule: the board marks a new app valid only after `ready` + `snapshot` received and `hello` sent; otherwise it rolls back after 10 minutes of uptime.
- [ ] **Step 2:** Add row `ADR-030 | Companion firmware releases, OTA and crash dumps | PROPOSED (owner, 2026-11-13)` stating: images stored in Postgres (`LargeBinary`, newest 3 per owner) — no object storage or new vendor; RSA-3072 app signing without Secure Boot, key only on the owner's Mac, no eFuse; upload only via a new dedicated owner CLI command (a narrow exception to "raw uploads are app-only", which stays for every other path); board downloads only from its own backend (`url` is a path, not a URL); core dumps ≤ 64 KB, newest 5 per device; the 10-minute confirm window. It becomes DECIDED when the owner approves this plan (record the date).
- [ ] **Step 3: Commit** `docs(companion): add OTA to the device contract and propose ADR-030`.

### Task 2: Firmware releases in the backend — model: **sonnet** · board: no · after Task 1

**Files:**
- Create: `backend/app/companion/firmware.py`, `backend/alembic/versions/0055_companion_firmware.py`, `backend/tests/test_companion_firmware.py`, `backend/tests/firmware_fixtures.py`
- Modify: `backend/app/companion/models.py`, `backend/app/companion/access.py` (`COMPANION_ALLOWED`), `backend/app/main.py` (router)

**Interfaces:**
- Consumes: `trusted_device`, `current_principal`, `COMPANION_ALLOWED` (plan 2), `pair_companion`/`companion_token` (`backend/tests/companion_helpers.py`).
- Produces (migration 0051, both tables — Task 4 uses the second):
  - `companion_firmware`: `id` uuid PK, `owner_id`, `version` String(11), `min_version` String(11), `sha256` String(64), `size` Integer, `data` LargeBinary, `uploaded_at`; unique `(owner_id, version)`.
  - `companion_coredumps`: `id` uuid PK, `owner_id`, `device_id` FK devices, `fw_version` String(11), `elf_sha256` String(64) null, `sha256` String(64), `size` Integer, `data` LargeBinary, `created_at`; unique `(device_id, sha256)`.
- Produces (`firmware.py`): `def parse_semver(v: str) -> tuple[int, int, int]` (422 `FIRMWARE_INVALID` on bad input); `def check_image(data: bytes, version: str) -> None` — `data[0] == 0xE9`; app descriptor magic `0xABCD5432` (LE) at offset 32; NUL-terminated version at offset 48 == `version`; project name at offset 80 == `companion` (else `FIRMWARE_INVALID`); `len(data) % 4096 == 0` and `data[-4096] == 0xE7` and `data[-4095] == 0x02` (signature block, else `FIRMWARE_UNSIGNED`); `async def latest_release(db, owner_id: str) -> CompanionFirmware | None` (highest semver, not newest upload); `async def read_capped(request: Request, cap: int, code: str) -> bytes` (413 `code` past `cap`).
- Produces routes:
  - `PUT /api/v1/companion/firmware/{version}?min_version=X.Y.Z`, header `X-Content-Sha256`, body octet-stream — owner `trusted_device` with platform ≠ `companion`. Hash mismatch → 422 `FIRMWARE_HASH_MISMATCH`; same version + same sha256 → 200 replay; same version + other sha256 → 409 `FIRMWARE_EXISTS`; `min_version` > `version` → 422 `FIRMWARE_INVALID`. Returns `{version, sha256, size, min_version}`, 201. Keeps the 3 highest versions per owner, deletes the rest in the same transaction.
  - `GET /api/v1/devices/{device_id}/firmware` → `{version, url, sha256, size, min_version}` with `url = "/api/v1/companion/firmware/{version}/image"`. A companion may read only its own `device_id` (else 403 `DEVICE_SCOPE_DENIED`); an owner trusted device may read any of its live companions (else 404 `NOT_FOUND`). No release → 404 `FIRMWARE_NONE`.
  - `GET /api/v1/companion/firmware/{version}/image` → bytes, `Content-Length`, `application/octet-stream`; companion or owner device of the same owner; unknown → 404 `FIRMWARE_NONE`.
  - `COMPANION_ALLOWED` gains exactly `("GET", "/api/v1/devices/{device_id}/firmware")` and `("GET", "/api/v1/companion/firmware/{version}/image")`.
- Produces (tests): `def make_image(version: str, *, signed: bool = True, size: int = 8192) -> bytes` in `firmware_fixtures.py`.

- [ ] **Step 1: Failing tests** (`test_companion_firmware.py`): `test_upload_then_board_reads_metadata` (fields and `url` exact); `test_board_downloads_image_bytes` (sha256 of the body equals metadata); `test_board_cannot_upload` (companion token on PUT → 403 `DEVICE_SCOPE_DENIED`); `test_board_cannot_read_other_board_firmware` (two companions, A asks for B → 403 `DEVICE_SCOPE_DENIED`); `test_latest_is_highest_semver` (upload 0.10.0 then 0.9.0 → 0.10.0); `test_upload_rejects` parametrized: hash mismatch, unsigned, wrong embedded version, wrong project, `min_version` above `version`, bad semver; `test_upload_too_large_is_413` (4 194 305 B → 413 `FIRMWARE_TOO_LARGE`, without buffering more than the cap — assert via a streaming body generator that stops being read); `test_same_version_same_hash_replays_other_hash_conflicts`; `test_keeps_three_highest`; `test_no_release_is_404`. Plan 2's `test_companion_denied_everywhere_but_allow_list` must still pass with the two new allow-list entries.
- [ ] **Step 2:** Run `PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests/test_companion_firmware.py` → FAIL.
- [ ] **Step 3: Implement** (route `/devices/{device_id}/firmware` must not be shadowed by core device routes — `test_upload_then_board_reads_metadata` proves it). Migration, `alembic upgrade head && alembic check`, `backend/tests/test_clean_migrations.py` passes.
- [ ] **Step 4:** PASS; full suite once (`make test`); `make openapi`; ruff/mypy/bandit.
- [ ] **Step 5: Commit** `feat(companion): store signed firmware releases and serve them to boards`.

### Task 3: `ota_available` push — model: **sonnet** · board: no · after Task 2

**Files:** Modify `backend/app/companion/channel.py` (hello handler, metrics validation), `backend/app/companion/firmware.py` (after upload); Create `backend/tests/test_companion_ota_push.py`.

**Interfaces:**
- Produces: `def should_offer(fw_version: str | None, release: CompanionFirmware) -> bool` — true iff `fw_version` parses, `release.version > fw_version` and `fw_version >= release.min_version` (semver tuples).
- After `hello`: after the pending-command flush, send `{"type":"ota_available","version": ...}` if `should_offer`. After a successful (201) upload: for each live companion of the owner with `hub.is_online` and `should_offer(state.fw_version, release)`, `hub.send_to_device`.
- `metrics` accepts optional `light_sleep_pct` (0–100) and `ui_wakes_per_s` (≥ 0) and stores them in `last_metrics_json`.

- [ ] **Step 1: Failing tests:** `test_hello_with_old_version_gets_offer`; `test_hello_with_current_version_gets_none`; `test_below_min_version_gets_none`; `test_upload_pushes_to_online_board` (socket open, owner uploads → board receives `ota_available` before any other new frame); `test_replayed_upload_pushes_nothing`; `test_metrics_power_fields_stored`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS; ruff/mypy/bandit.
- [ ] **Step 5: Commit** `feat(companion): offer newer firmware over the channel`.

### Task 4: Core-dump intake — model: **sonnet** · board: no · after Task 2

**Files:** Create `backend/app/companion/coredumps.py`, `backend/tests/test_companion_coredumps.py`; Modify `backend/app/companion/access.py`, `backend/app/main.py`.

**Interfaces:**
- `POST /api/v1/companion/coredumps` — companion only (others 403 `COMPANION_ONLY`); headers `X-Fw-Version` (semver, required), `X-Elf-Sha256` (64 hex, optional); body ≤ 65 536 B via `read_capped` (413 `COREDUMP_TOO_LARGE`); empty body → 422 `VALIDATION_ERROR`. 201 `{id}`; same `(device_id, sha256)` → 200 with the stored `id`. Keeps the 5 newest per device. Added to `COMPANION_ALLOWED`.
- `GET /api/v1/companion/devices/{device_id}/coredumps` (owner trusted device) → `[{id, fw_version, elf_sha256, size, created_at}]` newest first; `GET /api/v1/companion/devices/{device_id}/coredumps/{dump_id}` → bytes. Other owner's device → 404.

- [ ] **Step 1: Failing tests:** `test_board_uploads_dump`; `test_same_dump_stored_once` (Review Focus 5); `test_dump_too_large_is_413`; `test_owner_lists_and_downloads`; `test_board_cannot_list_dumps` (403 `DEVICE_SCOPE_DENIED`); `test_keeps_five_newest`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS; `make openapi`; ruff/mypy/bandit.
- [ ] **Step 5: Commit** `feat(companion): accept crash dumps from boards`.

### Task 5: Firmware CI — model: **haiku** · board: no · any time

**Files:** Create `.github/workflows/firmware.yml`.

- [ ] **Step 1:** Workflow on `push`/`pull_request` with `paths: ['firmware/companion/**', '.github/workflows/firmware.yml']`. Job `sim` (ubuntu-latest): `cmake -S firmware/companion/sim -B build && cmake --build build -j && ctest --test-dir build --output-on-failure`. Job `build`: `cp firmware/companion/main/owner_contact.example.h firmware/companion/main/owner_contact.local.h`, then `espressif/esp-idf-ci-action` **pinned to a full commit SHA** (comment with the tag it resolves to: `gh api repos/espressif/esp-idf-ci-action/git/ref/tags/<tag>`) with `esp_idf_version: v6.1`, `target: esp32s3`, `path: firmware/companion`; after the build run a size gate: `build/companion.bin` ≤ 2 097 152 B (spec budget), fail otherwise. Upload `build/companion.bin` and `build/companion.elf` as a 7-day artifact. No secrets, no signing.
- [ ] **Step 2:** Validate locally: `actionlint .github/workflows/firmware.yml` (install via `brew install actionlint` if missing) → no errors; then push the branch and check both jobs are green with `gh run list --workflow firmware.yml --limit 1` (report the run URL).
- [ ] **Step 3: Commit** `ci(firmware): build the companion image and run host tests`.

### Task 6: Version, OTA decision and confirm logic (pure C) — model: **sonnet** · board: no · any time

**Files:** Create `firmware/companion/components/logic/{include/ota_logic.h,ota_logic.c}`, `firmware/companion/sim/test_ota_logic.c`; Modify `firmware/companion/sim/CMakeLists.txt` (add to the logic test list), `firmware/companion/CMakeLists.txt` (`if(NOT DEFINED PROJECT_VER) set(PROJECT_VER "0.2.0") endif()` before `project()`, so a test release can pass `-DPROJECT_VER`), `firmware/companion/main/app_main.c` (drop `FW_VERSION`, log `esp_app_get_description()->version`).

**Interfaces (pure, no IDF):**
```c
int  semver_parse(const char *s, uint16_t out[3]);          /* 0 ok, -1 bad */
int  semver_cmp(const char *a, const char *b);              /* <0, 0, >0; bad input sorts lowest */
typedef struct { char version[12]; char min_version[12]; char url[96]; char sha256[65]; uint32_t size; } ota_meta_t;
typedef enum { OTA_INSTALL, OTA_UP_TO_DATE, OTA_TOO_OLD, OTA_KNOWN_BAD, OTA_BAD_URL, OTA_BAD_SIZE, OTA_BAD_META } ota_verdict_t;
ota_verdict_t ota_decide(const char *running, const char *bad_version, const ota_meta_t *m, uint32_t slot_size);
typedef enum { CONFIRM_WAIT, CONFIRM_VALID, CONFIRM_ROLLBACK } confirm_t;
typedef struct { bool pending; bool got_ready, got_snapshot, sent_hello; uint32_t deadline_ms; } ota_confirm_t;
void      ota_confirm_start(ota_confirm_t *c, bool pending_verify, uint32_t now_ms, uint32_t window_ms);
confirm_t ota_confirm_update(ota_confirm_t *c, uint8_t channel_event /* 1 ready, 2 snapshot, 3 hello sent, 0 tick */, uint32_t now_ms);
```
`ota_decide` order: bad meta (unparsable versions, sha256 not 64 hex) → `OTA_BAD_META`; `url` must start with `/api/v1/companion/firmware/`, contain no `..`, `//` or `://` → else `OTA_BAD_URL`; `size == 0 || size > slot_size` → `OTA_BAD_SIZE`; `version <= running` → `OTA_UP_TO_DATE`; `running < min_version` → `OTA_TOO_OLD`; `version == bad_version` → `OTA_KNOWN_BAD`; else `OTA_INSTALL`. `ota_confirm_update` returns `CONFIRM_VALID` once all three events have happened before the deadline (any order), `CONFIRM_ROLLBACK` once `now_ms ≥ deadline_ms` while still pending, `CONFIRM_WAIT` otherwise; a non-pending start always returns `CONFIRM_VALID` and never `ROLLBACK`.

- [ ] **Step 1: Failing tests** (`test_ota_logic.c`): `test_semver_orders_numerically` (`0.10.0 > 0.9.9`; `"1.2"`, `"a.b.c"`, `"1.2.3.4"`, `"1000.0.0"` → parse −1); `test_install_newer`; `test_up_to_date_and_older`; `test_too_old_for_min_version`; `test_bad_version_never_retried` (Review Focus 1: running 0.2.0, bad 0.3.0, offer 0.3.0 → `OTA_KNOWN_BAD`; offer 0.3.1 → `OTA_INSTALL`); `test_url_must_be_own_api_path` (`https://evil/x`, `http://…`, `//host/x`, `/api/v1/companion/firmware/../../x`, `/other` → `OTA_BAD_URL`); `test_size_limits` (0, slot+1 → `OTA_BAD_SIZE`); `test_confirm_needs_all_three_events`; `test_confirm_rolls_back_after_window`; `test_not_pending_never_rolls_back`.
- [ ] **Step 2:** Run `ctest -R ota_logic` → FAIL. **Step 3:** Implement. **Step 4:** PASS; `idf.py build` passes and the boot log shows `0.2.0`.
- [ ] **Step 5: Commit** `feat(firmware): add OTA decision and confirm logic`.

### Task 7: Power and orientation logic (pure C) — model: **sonnet** · board: no · any time

**Files:** Create `firmware/companion/components/logic/{include/power_fsm.h,power_fsm.c,include/orient.h,orient.c}`, `firmware/companion/sim/{test_power_fsm.c,test_orient.c}`; Modify `firmware/companion/sim/CMakeLists.txt`.

**Interfaces (pure, integer-only — no float, no sqrt, spec §4.6 CPU):**
```c
typedef enum { PWR_ACTIVE, PWR_DIM, PWR_OFF } pwr_state_t;
typedef enum { PWR_IN_TICK, PWR_IN_TOUCH, PWR_IN_BUTTON, PWR_IN_LIFT, PWR_IN_FACE_DOWN, PWR_IN_FACE_UP, PWR_IN_HOLD /* ui animating or combo held */ } pwr_in_t;
typedef struct { pwr_state_t state; bool face_down; uint32_t last_activity_ms, dim_ms, off_ms; } power_t;
void        power_init(power_t *p, uint32_t dim_ms, uint32_t off_ms, uint32_t now_ms);
pwr_state_t power_update(power_t *p, pwr_in_t in, uint32_t now_ms);
typedef enum { ORIENT_NONE, ORIENT_FACE_DOWN, ORIENT_FACE_UP, ORIENT_LIFT } orient_ev_t;
typedef struct { int16_t rest[3]; uint32_t still_since_ms, down_since_ms; bool down, have_rest; int8_t z_sign; } orient_t;
void        orient_init(orient_t *o, int8_t face_down_z_sign);
orient_ev_t orient_update(orient_t *o, int16_t ax_mg, int16_t ay_mg, int16_t az_mg, uint32_t now_ms);
```
Rules: `ACTIVE → DIM` at `dim_ms` (Kconfig `AELYS_DIM_S`, default 30) after the last activity, `→ OFF` at `off_ms` (`AELYS_OFF_S`, default 60); `TOUCH`, `BUTTON`, `LIFT`, `HOLD` are activity and wake to `ACTIVE`; `FACE_DOWN` → `OFF` immediately and while face-down `TOUCH` is ignored (button and `FACE_UP`/`LIFT` still wake). Orientation: face-down = `z_sign·az ≥ 800` mg with `|ax|,|ay| ≤ 300` held 1000 ms; `FACE_UP` when that stops; rest vector captured after 2000 ms with every axis moving < 50 mg; `LIFT` when the angle to the rest vector exceeds 25° (compare `dot² < cos²(25°)·|a|²·|r|²` in `int64_t`, `cos² ≈ 821/1000`) for 300 ms; a new rest is captured after the next 2000 ms still.

- [ ] **Step 1: Failing tests:** `test_dims_then_off`; `test_touch_wakes`; `test_face_down_turns_off_now`; `test_touch_ignored_face_down` (Review Focus 4); `test_button_wakes_face_down`; `test_hold_keeps_active`; `test_face_down_needs_1s` (900 ms → nothing); `test_tilt_from_rest_is_lift` (30° → `LIFT`, 20° → none); `test_noise_is_not_lift` (±40 mg jitter for 10 s → none); `test_face_up_after_down`.
- [ ] **Step 2:** Run `ctest -R "power_fsm|orient"` → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(firmware): add screen power and orientation logic`.

### Task 8: Signed images, rollback bootloader and the release script — model: **sonnet** · board: **yes** · after plan 3's board tasks (Lane C note) · owner present

**Files:** Modify `firmware/companion/sdkconfig.defaults`, `firmware/companion/README.md`, `firmware/companion/AGENTS.md`; Create `firmware/companion/tools/{flash_signed.py,release.py}`, `firmware/companion/tools/test_release.py`.

**Interfaces:**
- `sdkconfig.defaults` adds the four signing options from Global Constraints and `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`.
- `tools/flash_signed.py [--port P]` — `idf.py build`; signs `build/companion.bin` → `build/companion-signed.bin` with `espsecure sign-data --version 2 --keyfile $AELYS_FW_SIGNING_KEY`; `espsecure verify-signature --version 2` on it; flashes bootloader, partition table, `ota_data_initial.bin` and the signed app at the offsets in `build/flasher_args.json` with `esptool write-flash` (no `erase-flash`). Exit 2 with `signing key not found at <path>` when the key is missing; never prints key material.
- `tools/release.py [--min-version X.Y.Z] [--origin https://HOST] [--apply]` — refuses unless `git rev-parse HEAD == origin/main` after `git fetch` and `git status --porcelain firmware/companion` is empty; builds, signs, verifies, checks `check_image` rules locally (same offsets as Task 2) and size ≤ 2 MB; copies `companion-signed.bin` and `companion.elf` to `~/aelys-releases/companion/<version>/`; without `--apply` prints the plan; with `--apply` runs `aelys --origin HOST companion firmware-upload <file> --version V --min-version M --apply` (Task 13). `--min-version` defaults to `MAJOR.0.0` of the new version. Test releases only: `--test-overlay FILE --version X.Y.Z` builds into `build-test/` with `SDKCONFIG_DEFAULTS="sdkconfig.defaults;FILE"` and `-DPROJECT_VER=X.Y.Z` (FILE lives outside the repo, so the tree stays clean) and prints `TEST BUILD` before uploading; `--version` is refused without `--test-overlay`.
- `tools/test_release.py` (pytest, no board, no key): refuses on a dirty tree / HEAD ≠ origin/main (monkeypatched `git`); `--version` without `--test-overlay` refused; a fake signed image passes the local check and an unsigned one fails.

- [ ] **Step 1: Owner step (agent does not do this):** the owner runs `mkdir -p ~/.aelys && espsecure generate-signing-key --version 2 --scheme rsa3072 ~/.aelys/companion-signing-key.pem && chmod 400 ~/.aelys/companion-signing-key.pem` and keeps an offline copy. The agent only checks `test -r ~/.aelys/companion-signing-key.pem`. Losing the key means no more OTA (USB re-flash with a new key still works — no eFuse involved); record this in `README.md`.
- [ ] **Step 2: Failing tests** `.venv/bin/python -m pytest -q firmware/companion/tools/test_release.py` → FAIL. **Step 3:** Implement both scripts → PASS.
- [ ] **Step 4: Board.** The bootloader must change (rollback support): `flash_signed.py` writes it. The owner runs `python3 tools/flash_signed.py`; then `python3 tools/serlog.py --seconds 10 --reset` → boot log shows `0.2.0`, no `No signature block` / abort. Report that plain unsigned `idf.py app-flash` is now unsupported (do not try it on the board). Run `tools/release.py` without `--apply` on this build: its local image check (the Task 2 offsets and the 4 KB signature sector ending the file) must pass on the real `espsecure` output — if the layout differs, fix `check_image`, `make_image` and the script together and say so.
- [ ] **Step 5:** Update `AGENTS.md` (firmware): USB flashing only via `tools/flash_signed.py`; agents never read or print the key. Tell plan 3's controller via the shared notes folder.
- [ ] **Step 6: Commit** `build(firmware): sign app images and enable rollback`.

### Task 9: OTA client with confirm and rollback — model: **sonnet** · board: **yes** · after Tasks 2, 3, 6, 8, 12, 13 merged, backend deployed to Railway, production Mac app reinstalled from `main`, plan 3 link working

**Files:** Create `firmware/companion/components/ota/{CMakeLists.txt,include/ota.h,ota.c,Kconfig}`; Modify plan 3's link component (the file that handles `ready`/`snapshot`/`hello`, and its message dispatch), `firmware/companion/main/app_main.c`, `firmware/companion/main/store_nvs.{c,h}` (key `ota_bad`).

**Interfaces:**
- Consumes: `ota_decide`, `ota_confirm_*` (Task 6); `power_state()` (Task 12); from plan 3: the API base URL, the current access token, and a way to close/reopen the channel (name them in the report).
- Produces (`ota.h`):
  - `void ota_boot_check(void);` — first thing in `app_main` after NVS: if the running partition is `ESP_OTA_IMG_PENDING_VERIFY`, start the confirm window (`CONFIG_AELYS_OTA_CONFIRM_S`, default 600); if `esp_ota_get_last_invalid_partition()` has an app descriptor, save its version to NVS `ota_bad`.
  - `void ota_on_channel(uint8_t event);` — the link calls it on `ready` (1), first `snapshot` (2), after sending `hello` (3); a 1 s tick (0) comes from the metrics task. `CONFIRM_VALID` → `esp_ota_mark_app_valid_cancel_rollback()`; `CONFIRM_ROLLBACK` → `esp_ota_mark_app_invalid_rollback_and_reboot()`.
  - `void ota_offer(const char *version);` — the link calls it on `ota_available`. Remembers the offer; the work runs in the link task when `power_state() == PWR_OFF` (flash writes stall the caches and would drop frames): GET metadata → `ota_decide` → close the channel → `esp_https_ota` with `Authorization: Bearer` set in `http_client_init_cb`, `bulk_flash_erase = false`, buffer in PSRAM → SHA-256 of the first `size` bytes of the written partition must equal `meta.sha256` → `esp_https_ota_finish` (verifies the RSA signature) → `esp_restart()`. Any failure: abort, reopen the channel, do not retry the same version for 1 h (RAM only).

- `components/ota/Kconfig`: `AELYS_OTA_CONFIRM_S` (int, default 600), and two test hooks, default `n`, used only through `release.py --test-overlay`: `AELYS_OTA_TEST_NO_HELLO` (the link never sends `hello`) and `AELYS_OTA_TEST_ABORT` (`abort()` 3 s after boot).

- [ ] **Step 1:** Implement and build; `ctest` still green.
- [ ] **Step 2: Board — good update.** Flash 0.2.0 (the committed version) with `flash_signed.py`. Commit `PROJECT_VER 0.2.1`, merge to `main`; **the owner** runs `python3 tools/release.py --apply` from fresh `main`. Expected within 2 min of the screen turning off: log `ota: installing 0.2.1`, reboot, `0.2.1` running, `ota: marked valid` after `hello`; backend `GET /api/v1/companion/devices/{id}` shows `fw_version 0.2.1`.
- [ ] **Step 3: Board — rollback, never confirms.** Overlay file in the scratchpad: `CONFIG_AELYS_OTA_CONFIRM_S=60`, `CONFIG_AELYS_OTA_TEST_NO_HELLO=y`; owner runs `release.py --test-overlay <file> --version 0.2.2 --apply`. Expected: boots 0.2.2, after 60 s `rollback`, reboots into 0.2.1, NVS `ota_bad = 0.2.2`; the next `ota_available 0.2.2` logs `known bad` and downloads nothing (Review Focus 1).
- [ ] **Step 4: Board — crash at boot and power cut.** Overlay `CONFIG_AELYS_OTA_TEST_ABORT=y`, version 0.2.3 → bootloader returns to 0.2.1. Then owner releases 0.2.4 (no overlay: commit the bump, merge, release) and cuts power mid-download (USB out + battery switch, owner action) → board boots 0.2.1, retries on the next `ota_available` (or after 1 h), ends on 0.2.4. Report every log excerpt.
- [ ] **Step 5: Commit** `feat(firmware): install signed OTA updates with rollback`.

### Task 10: Core-dump upload on the next connect — model: **sonnet** · board: **yes** · after Tasks 4 and 9

**Files:** Create `firmware/companion/components/ota/coredump_upload.c` (same component; one network client already lives there); Modify `ota.h`, plan 3's link (call site).

**Interfaces:**
- Produces: `bool coredump_pending(void);` (`esp_core_dump_image_check() == ESP_OK`) and `esp_err_t coredump_upload(const char *api_base, const char *token);` — streams the partition image (`esp_core_dump_image_get`) in 4 KB reads with `esp_http_client_open/write` to `POST /api/v1/companion/coredumps`, headers `X-Fw-Version` and `X-Elf-Sha256` from `esp_core_dump_get_summary()->app_elf_sha256`; on 200/201 `esp_core_dump_image_erase()`; on any error keep it. The link calls it after login and **before** opening the channel socket (one TLS session at a time), skipping it if `heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL) < 40960`.

- [ ] **Step 1:** Implement; build.
- [ ] **Step 2: Board.** Scratch build with a debug trigger (scratch-only, e.g. `abort()` on the 3rd boot-button press) — flash with `flash_signed.py`, trigger, board reboots, connects → backend lists one dump for the device with `fw_version` = running version; second boot uploads nothing. Owner fetches it (`aelys … api_binary` path allowed in Task 13) and the agent decodes it: `idf.py coredump-info --core <file> --core-format raw` against `~/aelys-releases/companion/<version>/companion.elf` (or the scratch build's ELF) → backtrace shows the trigger function.
- [ ] **Step 3: Board — upload fails.** With Wi-Fi off after the crash (owner unplugs the router or the agent uses a scratch build with a wrong API host): the dump survives a reboot and is sent once the network is back (Review Focus 5).
- [ ] **Step 4: Commit** `feat(firmware): send crash dumps on the next connect`.

### Task 11: Quiet idle — ui and input wake-ups — model: **sonnet** · board: **yes** · any time the board is free

**Files:** Modify `firmware/companion/components/board/lv_port.c`, `firmware/companion/components/board/board_input.c`, `firmware/companion/components/board/include/board.h`, `firmware/companion/main/metrics.c`.

The `ui` loop clamps its sleep to 16 ms (`if (wait > 16) wait = 16;`), so an idle screen wakes the task ~62 times a second; the `input` task polls every 10 ms (100 Hz) even with no finger down. Both block light sleep later.

**Interfaces:**
- `lv_port.c`: sleep for `min(lv_timer_handler() result, ms until the next 5 s stats publish)`; `LV_NO_TIMER_READY` means "until an event or the stats deadline"; keep the ≥ 1 ms floor. Count loop wake-ups; `uint32_t lv_port_wakes(void)` returns the running count.
- `board_input.c`: when no finger is down and neither key is held, block on a task notification from the touch-INT / BOOT GPIO ISR with a timeout of 100 ms (AXP2101 PWR-key poll; its edge status register latches presses, so none are lost); poll every 10 ms only while something is held. If the Waveshare BSP 3.0.0 schematic/header shows an AXP2101 IRQ line to the S3, use it instead and say so.
- `metrics.c`: the metrics line gains `ui_wakes=<per second over the period>`; plan 3's `metrics` message sends it as `ui_wakes_per_s`.

- [ ] **Step 1: Baseline on the board** — flash (signed if Task 8 is done), home idle 60 s with metrics period 10 s (scratch defaults, not committed): record `ui_wakes`, `fps`, `worst_us`.
- [ ] **Step 2:** Implement.
- [ ] **Step 3: Board check:** idle home `ui_wakes ≤ 10`; bouncing/hold-ring paths still ≥ 55 fps (the plan 1 bench and the two-button hold); touch latency self-test (`CONFIG_AELYS_INPUT_SELFTEST`) median ≤ 30 ms, max ≤ 50 ms; owner taps 10 times — all register; two-button ICE hold still opens in 2 s.
- [ ] **Step 4:** Update `budgets.md` with before/after numbers. **Commit** `perf(firmware): stop idle polling in the ui and input tasks`.

### Task 12: Screen power — dim, off, face-down, wake — model: **sonnet** · board: **yes** · after Tasks 7 and 11

**Files:** Create `firmware/companion/components/board/board_imu.c`, `firmware/companion/main/power.c`, `firmware/companion/main/power.h`; Modify `firmware/companion/components/board/{board_display.c,include/board.h,include/board_pins.h,Kconfig.projbuild}`, `firmware/companion/main/{app_main.c,Kconfig.projbuild}`, `firmware/companion/components/board/lv_port.c`.

**Interfaces:**
- `board.h`: `esp_err_t board_display_set(uint8_t brightness /* 0 = sleep */);` — CO5300 `0x51` brightness; 0 → display off + sleep-in (`0x28`, `0x10`); any other value from sleep → sleep-out (`0x11`), the datasheet wait, display on (`0x29`), then brightness. `esp_err_t board_imu_start(void (*on_sample)(int16_t ax, int16_t ay, int16_t az));` — QMI8658 (probe 0x6B then 0x6A, WHO_AM_I 0x05), accelerometer only, ±2 g, low ODR; samples at 10 Hz with the screen on, 5 Hz off (or its wake-on-motion interrupt if an INT pin is wired — check the BSP and say which).
- `board_pins.h`: `#define IMU_FACE_DOWN_Z_SIGN (+1 or -1)` — **calibrated on the board** (Step 2), with a comment naming the date and the raw reading.
- `lv_port.c`: `void lv_port_set_paused(bool paused);` — while paused the ui task drains events but does not call `lv_timer_handler()`; on resume it invalidates the active screen.
- `power.h`: `void power_start(void);` (owns `power_t`/`orient_t`, feeds them from input events, IMU samples and a 1 s tick); `pwr_state_t power_state(void);` (read by OTA). `ACTIVE` → brightness `CONFIG_AELYS_BRIGHT` (default 255); `DIM` → `CONFIG_AELYS_DIM_BRIGHT` (default 64); `OFF` → `board_display_set(0)` + `lv_port_set_paused(true)`. The two-button combo and `UI_EV_COMBO_*` are `PWR_IN_HOLD`/`BUTTON` and keep working while off (ICE opens from sleep, spec §4.11).

- [ ] **Step 1:** Implement; build; `ctest` green.
- [ ] **Step 2: Calibrate** — the owner lays the board face-down, then face-up; the agent reads raw `az` from a temporary log line and sets `IMU_FACE_DOWN_Z_SIGN`. Remove the log line.
- [ ] **Step 3: Board check** (default timers): untouched → dim at 30 s, off at 60 s; face-down → off within 1.5 s; tap while face-down → stays off (Review Focus 4); BOOT press, tap (face-up) or lifting the board → screen on; ICE hold with the screen off → ICE card. Wake latency from the input event to the end of the first flush (log `esp_timer` delta, 10 wakes) ≤ 200 ms median — report median and max.
- [ ] **Step 4: Commit** `feat(firmware): dim and turn off the screen, face-down and lift wake`.

### Task 13: Owner CLI — firmware upload and dump download — model: **sonnet** · board: no · after Task 2 (and Task 4 for the dump path)

**Files:** Modify `packages/native-transport/src/transport/cli/commands.rs` (and `cli.rs` if parsing lives there), `packages/native-transport/src/transport/cli/operations.json`, `packages/native-transport/src/transport/cli/commands_tests.rs`.

**Interfaces:**
- New command `aelys --origin URL companion firmware-upload FILE --version X.Y.Z --min-version X.Y.Z [--apply]` — without `--apply` prints `{version, min_version, size, sha256}`; with `--apply` sends the file bytes as `PUT /api/v1/companion/firmware/{version}?min_version=…` with `Content-Type: application/octet-stream` and `X-Content-Sha256`. The general rule "raw uploads are app-only, not CLI" stays for every other path: this command can reach only that one route, file ≤ 4 194 304 B, version strings validated before any request.
- `binary_allowed` additionally accepts `/api/v1/companion/devices/{id}/coredumps/{dump_id}` (GET).

- [ ] **Step 1: Failing tests** in `commands_tests.rs`: preview without `--apply` makes no request; bad version → `VALIDATION_ERROR`; file > 4 MB → `VALIDATION_ERROR`; a generic `api PUT … --upload` is still rejected; coredump path is binary-allowed, other binary paths unchanged.
- [ ] **Step 2:** `cargo test --manifest-path packages/native-transport/Cargo.toml --locked --lib` → FAIL. **Step 3:** Implement. **Step 4:** PASS; `cargo fmt --manifest-path packages/native-transport/Cargo.toml -- --check`; `cargo clippy --manifest-path packages/native-transport/Cargo.toml --all-targets --locked -- -D warnings` (the `frontend.yml` gates).
- [ ] **Step 5: Commit** `feat(cli): upload companion firmware and fetch crash dumps`. The production app picks this up only after a merge to `main` and `scripts/build-mac-app.sh --install` — the release in Task 9 needs that first.

### Task 14: QEMU boot smoke — model: **sonnet** · board: no · any time · time-box 2 h

**Files:** Create `firmware/companion/sdkconfig.qemu` (defaults overlay: `CONFIG_AELYS_NO_WIFI=y`), `firmware/companion/tools/qemu_smoke.sh`; Modify `.github/workflows/firmware.yml` (job `qemu`).

- [ ] **Step 1:** `tools/qemu_smoke.sh` builds with `SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.qemu"` into `build-qemu/`, runs `idf.py -B build-qemu qemu` (ESP32-S3 is a QEMU target in v6.1; octal PSRAM via the tool's own flags) with a 20 s timeout, passes iff the log contains `Aelys companion fw` and contains none of `Guru Meditation`, `abort()`, `rst:0xc`. The panel and touch are absent in QEMU; `board_init failed … (idle)` is an accepted outcome — say so in the script.
- [ ] **Step 2:** Run locally → PASS. Add the CI job (same pinned action, `idf_tools.py install qemu-xtensa` inside its command).
- [ ] **Step 3:** If it cannot pass within the time-box (QEMU missing a peripheral the boot path needs), do not hack the firmware for it: record the blocker in `firmware/companion/docs/next-steps.md`, drop the job, commit only the note.
- [ ] **Step 4: Commit** `ci(firmware): boot the image in QEMU`.

### Task 15: CPU and Wi-Fi power, then cold start — model: **sonnet** · board: **yes** · after Tasks 8, 11, 12 (signing adds a boot-time signature check, so cold start is measured last)

**Files:** Modify `firmware/companion/sdkconfig.defaults`, `firmware/companion/main/{app_main.c,power.c,metrics.c}`, `firmware/companion/components/board/lv_port.c`, `firmware/companion/components/net/net_wifi.c`, `firmware/companion/docs/budgets.md`, `firmware/companion/docs/next-steps.md`.

**Part A — `esp_pm` and Wi-Fi power:**
- `sdkconfig.defaults`: `CONFIG_PM_ENABLE=y`, `CONFIG_FREERTOS_USE_TICKLESS_IDLE=y`, `CONFIG_PM_LIGHT_SLEEP_CALLBACKS=y`, `CONFIG_USJ_NO_AUTO_LS_ON_CONNECTION=y` (keeps the USB console and Improv alive while plugged into the Mac — so light-sleep numbers come only from battery runs).
- `app_main.c`: `esp_pm_configure(&(esp_pm_config_t){.max_freq_mhz = 240, .min_freq_mhz = 80, .light_sleep_enable = true})`.
- `lv_port.c`: one `esp_pm_lock_handle_t` of type `ESP_PM_NO_LIGHT_SLEEP` plus one `ESP_PM_CPU_FREQ_MAX`, both acquired at `LV_EVENT_REFR_START`/while an LVGL animation runs and released when `lv_timer_handler()` reports nothing ready and no area is invalid — never held while paused.
- `net_wifi.c`: `sta.listen_interval = 3` at connect; `esp_wifi_set_ps(WIFI_PS_MAX_MODEM)` when `power_state()` becomes `PWR_OFF`, `WIFI_PS_MIN_MODEM` otherwise (expose `void net_set_low_power(bool on)`; `power.c` calls it).
- `metrics.c`: `light_sleep_pct` from the light-sleep enter/exit callbacks (`esp_pm_light_sleep_register_cbs`), sent by plan 3's `metrics` message.

**Part B — cold start (budget ≤ 1.5 s; today 1482 ms with 1 of 9 readings over):**
- Add one-shot WARN marks (`boot: <phase> <ms>`) at `app_main` entry, after `board_init`, after `store_*`, after `lv_port_start`, at first flush; read 3 cold boots (`serlog.py --reset --seconds 6`); attack the largest phase first. Candidates to try in this order and keep only what moves the number: start Wi-Fi after the first flush (it currently starts right after `ui_setup`, racing the first frame); shorten CO5300 init waits to the datasheet minimum; render the first frame before loading non-visible screens; check that the boot-time app signature check (Task 8) is not on the critical path, and if it is, report its cost before changing anything security-related.

- [ ] **Step 1:** Implement Part A; build; flash with `flash_signed.py`.
- [ ] **Step 2: Board, plugged in:** UI still ≥ 55 fps on the bench and hold ring, touch median ≤ 30 ms; channel stays connected 10 min with the screen off (heartbeats every 30 s), pushes arrive within 2 s.
- [ ] **Step 3: Board, on battery (owner unplugs USB for 30 min, screen off, online):** backend `last_metrics_json.light_sleep_pct ≥ 80` and the channel never dropped (no reconnect in the metrics). Report the AXP2101 battery percentage before/after (informational, not a gate).
- [ ] **Step 4:** Implement Part B; 9 cold boots (`--reset`) plus 1 owner power-cycle → all ≤ 1450 ms (50 ms margin). Record every reading.
- [ ] **Step 5:** Update `budgets.md` (power rows, cold start, idle wakes) and `next-steps.md` (close the carried items this plan resolved, add any new ones). **Commit** `perf(firmware): light sleep, Wi-Fi power save and faster cold start` (or two commits if Part B is separate).

---

## Execution notes for the controller

- Lane C board tasks interleave with plan 3's board tasks; check with plan 3's controller (shared notes folder) before taking the port, and announce Task 8 (signing) there before it starts — after it, unsigned app flashes abort at boot.
- Tasks 8, 9, 10, 12, 15 need the owner present: key generation, every release upload (Touch ID / Keychain prompt in the CLI), face-down calibration, power cuts and battery runs. Agents never run `espsecure sign-data` themselves and never see the key.
- Task 9's test releases (0.2.1–0.2.4) go to the production backend; they are owner-only and only this board consumes them. Use versions in that order; never reuse a number.
- Backend tasks (1–4) branch from `main` after plan 2 lands; run the full backend suite in Task 2 (allow-list change).
- After the last task: merge to `main`, then the owner installs the production Mac app from fresh `main` (`scripts/build-mac-app.sh --install`) and releases the final firmware with `tools/release.py --apply`. Move stale `Aelys*.app` copies to the Trash (CLAUDE.md).
