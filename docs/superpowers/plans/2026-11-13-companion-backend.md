# Aelys Companion — backend (plan 2 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The backend can pair an Aelys companion board, give it only the narrow rights it needs, push it a live snapshot (deadline, next event, unread count, focus) over a WebSocket, accept its three kinds of actions, and relay the owner's lost-mode / find / ICE / Wi-Fi commands to it.

**Architecture:** New package `backend/app/companion/` owns everything companion-specific (access list, snapshot, actions, hub, channel, owner commands); shared domain logic that today lives inside HTTP handlers (focus, task completion) is extracted into small services first and reused by both the old routes and the companion. Rights are enforced fail-closed inside `current_principal`: a `companion` device gets 403 on every route not on an explicit allow-list. Push uses an in-process hub (one Railway replica, one uvicorn process) fed by SQLAlchemy `after_commit`, the same pattern as `app/automation/hooks.py`.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, Pydantic v2, pytest + pytest-asyncio (SQLite per test file), `cryptography` (already used for P-256).

**Spec:** `docs/superpowers/specs/2026-11-12-esp32-companion-design.md` §4.3–4.5, §4.11 (backend bullets), §6. Carry-over from plan 1: `firmware/companion/docs/next-steps.md`.

**Out of scope (later plans):** firmware endpoint + OTA upload (§4.4 item 6) → plan 4; app/web UI pages and the web "Add companion" USB page → plan 3; SOS (proposal only).

## Global Constraints

- Every HTTP route under `/api/v1`; errors as the code base already returns them: `HTTPException(status, detail={"code": "...", "message": "..."})` → body `{"detail":{"code","message"}}`. New codes in this plan: `DEVICE_SCOPE_DENIED` (403), `COMPANION_ONLY` (403), `PLATFORM_NOT_ALLOWED` (422), `DEVICE_OFFLINE` (409), `REAUTH_REQUIRED` (403); action result codes (inside `ActionResult.error_code`, HTTP 200): `ACTION_UNKNOWN`, `NO_ACTIVE_FOCUS`, `NOT_FOUND`, `POLICY_DENIED`.
- No new services, brokers or vendors; the hub is in-process (valid while `railway.json` has `numReplicas: 1` and the Dockerfile runs one uvicorn process — state this in the ADR).
- Every companion write goes through `ServerPolicyEngine().authorize` with `actor=f"device:{device_id}"` and companion scopes (`companion.focus`, `companion.tasks`, `companion.notifications`).
- The companion never receives a refresh token, a notification `body`, `data_json`, or the title of a notification whose `kind` is not allowed; allowed title prefixes: `task.`, `calendar.`, `focus.`.
- Fail closed: any route not on the allow-list → 403 `DEVICE_SCOPE_DENIED` for a `companion` principal; a stolen board must not reach pairing, device management, sync, mail, finance, notes, AI.
- Migration `backend/alembic/versions/0050_companion.py`, `down_revision = "0049_ai_image_attachments"`, inspector-guarded like `0024_device_pairing.py`.
- ADR-029 is written as **PROPOSED**; it becomes DECIDED only when the owner approves (approving this plan counts — record date).
- Validation before every commit (from `Makefile`/CI): `PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests/<file>`; `.venv/bin/ruff check backend/app backend/tests`; `.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs`; `.venv/bin/bandit -q -r backend/app -ll`; for schema changes `cd backend && PYTHONPATH=. ../.venv/bin/alembic upgrade head && PYTHONPATH=. ../.venv/bin/alembic check`; for HTTP route changes `make openapi` and commit `docs/openapi.json`.
- Tests follow `backend/tests/test_device_pairing.py`: own SQLite engine in `tmp_path`, `AsyncClient(ASGITransport(app))`, its `Key`/`new_secret`/`claim_owner`/`bearer` helpers (move the ones you need into `backend/tests/companion_helpers.py`, don't copy-paste). WebSocket tests use `starlette.testclient.TestClient(app).websocket_connect(..., headers=...)`.
- Git: branch `feat/companion-backend` in a worktree; Conventional Commits; explicit paths only (the main checkout has unrelated uncommitted work).

## Review Focus

1. **Stolen companion token on any other route** (pairing invite/approve, device revoke/enroll, `/sync/*`, notes, mail, finance, AI, `/auth/refresh`) → 403 `DEVICE_SCOPE_DENIED`. Test enumerates `app.routes` (Task 2).
2. **Notification of a kind outside the allow-list** (`telegram.*`, `automation`, `info`, any custom kind) → counted in `unread`, its title/body never sent (Task 3).
3. **The board retries an action after a reconnect** (same action id) → same result, no second effect (Task 4).
4. **Owner revokes the board while its socket is open and the board is silent** → socket closed with 4403 within 1 s of the revoke call (Task 7).
5. **Owner turns lost mode on while the board is offline** → stored and delivered on the next connect; `find` while offline → 409 `DEVICE_OFFLINE` (Task 8).

---

### Task 1: ADR-029 and the protocol contract — model: **haiku**

**Files:**
- Modify: `docs/DECISIONS.md` (new row after ADR-028)
- Create: `docs/companion-protocol.md`

- [ ] **Step 1:** Add row `| ADR-029 | Companion device (ESP32) with restricted rights and push channel | PROPOSED (owner, 2026-11-13) | … |` summarising: platform `companion`; fail-closed allow-list in `current_principal`; no refresh token for companion; WS `/api/v1/devices/channel`; in-process hub (1 replica, 1 process — revisit if scaled); companion actions through Policy Engine with device actor; notification titles only for `task.`/`calendar.`/`focus.` kinds; Wi-Fi credentials opaque to the server (ECIES by the app); error shape `{"detail":{...}}` as in code. Note the deviation from spec §4.4 item 8: push is driven by SQLAlchemy mapper events + `after_commit`, not by `sync_changes`, because notifications and focus sessions never reach `sync_changes`. Note that firmware/OTA (§4.4 item 6) is plan 4.
- [ ] **Step 2:** Write `docs/companion-protocol.md` — the contract plan 3's firmware is built against. Text frames, JSON, field `type`. Exactly these messages:
  - board → server: `hello {fw_version, board, features[]}`, `heartbeat {}`, `metrics {heap_min_internal, largest_block, psram_free, wifi_reconnects, uptime_s}`, `action {id (uuid4), kind, payload}`, `command_ack {id, ok, error_code?}`, `wifi_scan_result {id, networks:[{ssid, rssi, secure}]}`.
  - server → board: `ready {device_id}`, `heartbeat_ack {}`, `snapshot {snapshot}` (full replacement, also used for every change — no partial patches in v1), `action_result {id, ok, error_code?}`, `command {id, name, args}` with `name ∈ lost_mode | play_sound | ice_update | wifi_add | wifi_scan`, `error {code, message}`.
  - The snapshot schema from Task 3, the action kinds from Tasks 4–5, close codes `4401` (auth: re-login by signature), `4403` (revoked / not a companion: re-check with `/auth/device/challenge`, wipe pairing only if that says unknown/revoked), `4000` (replaced by a newer connection of the same device), heartbeat every 30 s.
- [ ] **Step 3: Commit** `docs(companion): propose ADR-029 and the device channel contract`.

### Task 2: `companion` platform and fail-closed rights — model: **sonnet**

**Files:**
- Create: `backend/app/companion/__init__.py`, `backend/app/companion/access.py`
- Modify: `backend/app/core/device_auth.py` (`PLATFORM` → add `companion`; reject `companion` in `/auth/setup/claim` and `/devices/register-key`; login response for companion), `backend/app/core/security.py:68` (`current_principal`), `backend/app/core/api.py:63` (`/auth/refresh` denies companion)
- Create: `backend/tests/companion_helpers.py`, `backend/tests/test_companion_access.py`

**Interfaces:**
- Produces: `COMPANION_ALLOWED: frozenset[tuple[str, str]]` of `(method, route_path)` in `access.py` — initially `{("GET", "/api/v1/companion/snapshot"), ("POST", "/api/v1/companion/actions")}`; later tasks add to it only by editing this set.
- Produces: `def ensure_companion_allowed(request: Request, device: Device | None) -> None` — raises 403 `DEVICE_SCOPE_DENIED` when `device.platform == "companion"` and `(request.method, request.scope["route"].path)` is not allowed.
- Produces: `current_principal(request: Request, credentials=..., db=...)` — same return type `tuple[User, Device | None]`, calls `ensure_companion_allowed` last.
- Produces (tests): `async def pair_companion(client) -> tuple[dict, Key, str]` (owner session, board key, device_id) via `/pairing/request` → `/approve` (SAS from `sas_code`) → `/finish`; `async def companion_token(client, key, device_id) -> str` via challenge/login.

- [ ] **Step 1: Failing tests** in `test_companion_access.py`:
  - `test_companion_pairs_through_request_flow` — `pair_companion` succeeds; device row `platform == "companion"`.
  - `test_companion_cannot_claim_setup_or_register_key` — `/auth/setup/claim` and `/devices/register-key` with `platform="companion"` → 422 `PLATFORM_NOT_ALLOWED` (a board must never become the first owner device or re-key itself).
  - `test_companion_login_returns_no_refresh` — login JSON has `refresh_token` null/absent; `/auth/refresh` with any token of that device → 403 `DEVICE_SCOPE_DENIED`.
  - `test_companion_denied_everywhere_but_allow_list` — for every `APIRoute` in `app.routes` (fill path params with a fixed uuid, bodies `{}`), a companion bearer gets 403 `DEVICE_SCOPE_DENIED` unless `(method, path)` ∈ `COMPANION_ALLOWED` or the route has no auth dependency (assert that set is exactly the known public routes: pairing request/claim/finish, device challenge/login, health, setup). Additionally assert by name that `/pairing/invite`, `/pairing/{pairing_id}/approve`, `/devices/{device_id}/revoke`, `/devices/register-key` and `/sync/pull` are denied, so a future change to the enumeration can't silently drop them.
  - `test_owner_devices_unaffected` — a `macos` device still reaches `/tasks`.
- [ ] **Step 2:** Run `PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests/test_companion_access.py` → FAIL.
- [ ] **Step 3: Implement.** Add `companion` to `PLATFORM` only (leave `schemas.py:17` `DeviceEnroll` regex unchanged so `/devices/enroll` keeps rejecting it). Grep every direct call of `current_principal(` (not `Depends`) and update. If `request.scope["route"]` is missing in a dependency, resolve it the same way FastAPI does and say how in the report. For companion login, still call `_issue_session` but return `refresh_token=None` and revoke-on-sight in `/auth/refresh`.
- [ ] **Step 4:** Tests PASS; run the full suite once (`make test`) — no regression; ruff, mypy, bandit clean.
- [ ] **Step 5: Commit** `security(auth): restrict companion devices to an allow-list`.

### Task 3: Snapshot — model: **sonnet**

**Files:**
- Create: `backend/app/companion/snapshot.py`, `backend/app/companion/api.py` (router), `backend/tests/test_companion_snapshot.py`
- Modify: `backend/app/main.py` (include `companion_router` with `prefix="/api/v1"` next to `device_auth_router`)

**Interfaces:**
- Produces (Pydantic, `snapshot.py`):
  ```python
  class SnapTask(BaseModel): id: str; title: str; due_at: datetime
  class SnapEvent(BaseModel): id: str; title: str; starts_at: datetime; ends_at: datetime | None; all_day: bool
  class SnapNotice(BaseModel): id: str; kind: str; title: str; created_at: datetime
  class SnapFocus(BaseModel): id: str; status: Literal["active", "paused"]; mode: str; started_at: datetime; elapsed_seconds: int
  class CompanionSnapshot(BaseModel):
      generated_at: datetime; next_task: SnapTask | None; overdue_count: int
      next_event: SnapEvent | None; unread_count: int; notices: list[SnapNotice]  # max 5, newest first
      focus: SnapFocus | None
  async def build_snapshot(db: AsyncSession, owner_id: str, now: datetime) -> CompanionSnapshot
  ALLOWED_NOTICE_PREFIXES = ("task.", "calendar.", "focus.")
  ```
  All datetimes UTC; the board converts with its own time zone.
- Produces: `GET /api/v1/companion/snapshot` → `CompanionSnapshot` (companion principals only: other platforms → 403 `COMPANION_ONLY`).

- [ ] **Step 1: Failing tests:**
  - `test_next_task_is_earliest_open_due_after_now` (done/cancelled ignored; overdue counted in `overdue_count`, not returned as `next_task`).
  - `test_next_event_includes_recurring_and_ongoing` (an event that started 10 min ago and ends later is returned; a recurring event's next occurrence is used; window 7 days).
  - `test_unread_counts_all_kinds_but_titles_only_allowed` — rows `task.reminder`, `calendar.reminder`, `telegram.digest`, `automation`, `info` unread → `unread_count == 5`, `notices` kinds ⊆ allowed, serialized JSON contains no `body`, no `data_json`, no title of the other kinds.
  - `test_focus_active_or_paused_only`.
  - `test_snapshot_route_companion_only` (macos device → 403 `COMPANION_ONLY`; companion → 200).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Reuse, don't copy: terminal task statuses from `domains/briefings.py`; event occurrence expansion from whatever `GET /calendar/occurrences` (`domains/api.py:539`) uses — extract it into a function if it is inline; `focus_elapsed` from `domains/api.py:286`. Add the route to `COMPANION_ALLOWED`.
- [ ] **Step 4:** Tests PASS; `make openapi`; ruff/mypy/bandit.
- [ ] **Step 5: Commit** `feat(companion): serve a privacy-filtered snapshot`.

### Task 4: Actions framework, idempotency and notification read — model: **sonnet**

**Files:**
- Create: `backend/app/companion/models.py` (`CompanionAction`, `CompanionState`), `backend/app/companion/actions.py`, `backend/alembic/versions/0050_companion.py`, `backend/tests/test_companion_actions.py`
- Modify: `backend/app/companion/api.py`, `backend/app/core/models.py` import list if models must be registered there for `Base.metadata`

**Interfaces:**
- Produces (tables in migration 0050):
  - `companion_actions`: `id` (PK, the board's uuid), `owner_id`, `device_id` (FK devices), `kind` String(40), `result_json` JSON, `created_at`; unique `(device_id, id)`.
  - `companion_state`: `device_id` PK FK, `owner_id`, `fw_version` String(40) null, `board` String(60) null, `last_hello_at`, `last_metrics_json` JSON null, `lost_mode_json` JSON null, `ice_json` JSON null, `pending_commands_json` JSON (list, default `[]`), `last_wifi_scan_json` JSON null, `updated_at`.
- Produces: `class ActionIn(BaseModel): id: UUID; kind: str; payload: dict = {}`; `class ActionResult(BaseModel): id: UUID; ok: bool; error_code: str | None = None`.
- Produces: `async def run_action(db, owner_id: str, device: Device, action: ActionIn) -> ActionResult` — replays a stored result for a known `(device_id, id)`; otherwise authorizes via Policy Engine (actor `device:{id}`, scope per kind), dispatches through `ACTION_HANDLERS: dict[str, Handler]`, stores the result, commits. Unknown kind → `ok=False, error_code="ACTION_UNKNOWN"`.
- Produces: `POST /api/v1/companion/actions` body `ActionIn` → `ActionResult` (already allowed in Task 2).
- This task registers one handler: `notification.read` (`payload {notification_id}`) → same effect as `POST /notifications/{id}/read`, scope `companion.notifications`; owner mismatch → `ok=False, error_code="NOT_FOUND"`.

- [ ] **Step 1: Failing tests:** `test_read_notification_action_marks_read`; `test_same_action_id_replays_result_without_second_effect` (Review Focus 3 — the second call returns the stored result even if the notification was marked unread meanwhile); `test_unknown_kind_returns_action_unknown`; `test_action_of_other_owner_notification_is_not_found`; `test_policy_denied_maps_to_error_code` (monkeypatch the engine to deny → `ok=False, error_code="POLICY_DENIED"`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement**; migration inspector-guarded; `alembic upgrade head && alembic check`; `tests/test_clean_migrations.py` still passes.
- [ ] **Step 4:** Tests PASS; `make openapi`; ruff/mypy/bandit.
- [ ] **Step 5: Commit** `feat(companion): add idempotent device actions`.

### Task 5: Focus and task services shared with the companion — model: **sonnet**

**Files:**
- Create: `backend/app/domains/focus_service.py`, `backend/app/domains/task_service.py`, `backend/tests/test_focus_task_services.py`
- Modify: `backend/app/domains/api.py` (`start_focus` ~:854, `stop_focus` ~:878, `_toggle_focus_pause` ~:892 call the services), `backend/app/ai/personal_tools.py` (`complete_task` ~:167 uses `task_service.complete_task`), `backend/app/companion/actions.py` (register handlers)

**Interfaces:**
- Produces (`focus_service.py`): `async def start_focus(db, owner_id: str, *, started_at: datetime, mode: str, task_id: str | None, idempotency_key: str | None) -> FocusSession`; `async def set_focus_paused(db, owner_id: str, focus_id: str, paused: bool, version: int | None) -> FocusSession`; `async def stop_focus(db, owner_id: str, focus_id: str, version: int | None) -> FocusSession`; `async def active_focus(db, owner_id: str) -> FocusSession | None`. Same errors as today (409 `TIMER_ACTIVE`, `IDEMPOTENCY_CONFLICT`, version conflicts).
- Produces (`task_service.py`): `async def complete_task(db, owner_id: str, task_id: str) -> Task` — lock, version-checked update to `status="completed"`, `record_domain_change`, the same automation hook as today; idempotent if already completed.
- Companion action kinds registered here: `focus.start {mode?: "pomodoro"|"stopwatch"}` (server time is `started_at`), `focus.pause`, `focus.resume`, `focus.stop` (act on `active_focus`; none → `ok=False, error_code="NO_ACTIVE_FOCUS"`), `task.complete {task_id}` — scopes `companion.focus` / `companion.tasks`.

- [ ] **Step 1: Failing tests:** service-level tests for each function (start twice → `TIMER_ACTIVE`; pause→resume→stop elapsed math matches `focus_elapsed`; `complete_task` sets `completed_at`, writes one `sync_changes` row, second call is a no-op); companion action tests `test_focus_actions_drive_the_active_session`, `test_task_complete_action`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Move logic out of the handlers into the services; handlers become thin callers. Existing focus/task/AI tests must stay green unchanged — that is the proof the extraction kept behaviour.
- [ ] **Step 4:** New + existing tests PASS (`make test`); ruff/mypy/bandit; `make openapi` (should be unchanged — if it changes, explain).
- [ ] **Step 5: Commit** `refactor(domains): extract focus and task completion services` then `feat(companion): add focus and task actions` (two commits).

### Task 6: Change hub — model: **sonnet**

**Files:**
- Create: `backend/app/companion/hub.py`, `backend/tests/test_companion_hub.py`

**Interfaces:**
- Produces:
  ```python
  class CompanionHub:
      def register(self, device_id: str, owner_id: str, send: Callable[[dict], Awaitable[None]]) -> Callable[[], None]  # returns unregister; a second register for the same device_id closes the first with 4000
      def is_online(self, device_id: str) -> bool
      async def send_to_device(self, device_id: str, message: dict) -> bool  # False if offline
      async def close_device(self, device_id: str, code: int) -> None
      def mark_owner_dirty(self, owner_id: str) -> None  # debounced 250 ms, then each connection of that owner rebuilds and sends {"type":"snapshot", ...}
  hub = CompanionHub()  # module singleton
  def install_change_listeners() -> None  # SQLAlchemy mapper events on Task, CalendarEvent, Notification, FocusSession → owner ids in session.info; after_commit → hub.mark_owner_dirty; after_rollback drops them
  ```
  Pattern: `app/automation/hooks.py` (`session.info`, `after_commit`, `after_rollback`, `after_soft_rollback`). Called once from `main.py` lifespan.
- Snapshot rebuild uses a short-lived `core_db.SessionLocal()` per rebuild, never a session held by a socket.

- [ ] **Step 1: Failing tests:** `test_commit_of_task_marks_owner_dirty_once` (two task writes in one transaction → one rebuild after debounce); `test_rollback_marks_nothing`; `test_notification_insert_triggers_rebuild` (notifications don't go through `sync_changes` — this proves the mapper hook covers them); `test_second_register_closes_first_with_4000`; `test_send_to_offline_device_returns_false`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; ruff/mypy/bandit; full suite once (mapper listeners must not break other tests).
- [ ] **Step 5: Commit** `feat(companion): push snapshots on data changes`.

### Task 7: Device channel `/api/v1/devices/channel` — model: **sonnet**

**Files:**
- Create: `backend/app/companion/channel.py`, `backend/tests/test_companion_channel.py`
- Modify: `backend/app/main.py` (route registered before any `/devices/{device_id}` pattern can shadow it — verify with a test), `backend/app/core/api.py:128` (revoke → `await hub.close_device(device_id, 4403)`)

**Interfaces:**
- Consumes: `hub` (Task 6), `build_snapshot` (Task 3), `run_action` (Task 4), `CompanionState` (Task 4).
- Produces: WebSocket `/api/v1/devices/channel`. Auth exactly like `app/agents/api.py:163-178` (Bearer from the `authorization` header only; 4401 for token/session problems, 4403 for missing/revoked device or platform ≠ `companion`), but: no DB session held across the loop (short sessions per message); a reader task and a writer queue so the server can push while the board is silent; revalidate device/session every 60 s and close 4403/4401 if revoked/expired; access-token expiry → close 4401.
- Message handling per `docs/companion-protocol.md`: on accept send `ready`, then `snapshot`; `hello` → upsert `CompanionState.fw_version/board/last_hello_at`, then flush `pending_commands_json` as `command` messages; `heartbeat` → `last_seen_at` + `heartbeat_ack`; `metrics` → `last_metrics_json`; `action` → `run_action` → `action_result`; `command_ack` → drop the matching pending command; `wifi_scan_result` → `last_wifi_scan_json`; unknown → `error {code:"UNKNOWN_MESSAGE"}`; invalid JSON or > 4 KB frame → `error {code:"VALIDATION_ERROR"}`.

- [ ] **Step 1: Failing tests:** `test_ready_then_snapshot`; `test_non_companion_device_gets_4403`; `test_bad_token_gets_4401`; `test_action_over_channel_returns_result`; `test_owner_creates_task_board_receives_new_snapshot` (owner `POST /tasks` with a due date → board gets a `snapshot` whose `next_task.id` matches); `test_revoke_closes_open_socket_within_1s` (Review Focus 4: board sends nothing; owner calls revoke; receive raises `WebSocketDisconnect(4403)`); `test_new_connection_replaces_old_with_4000`; `test_hello_flushes_pending_commands`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; full suite once; ruff/mypy/bandit.
- [ ] **Step 5: Commit** `feat(companion): add the device push channel`.

### Task 8: Owner commands (§4.11) and device state — model: **sonnet**

**Files:**
- Create: `backend/app/companion/commands.py`, `backend/tests/test_companion_commands.py`
- Modify: `backend/app/companion/api.py`

**Interfaces:**
- Produces routes (owner devices only: `trusted_device`, and the caller's platform ≠ `companion` — the allow-list already blocks the board itself; the target `device_id` must be the owner's live `companion`, else 404):
  - `GET /api/v1/companion/devices/{device_id}` → `{device_id, display_name, online: bool, last_seen_at, fw_version, public_key (base64url, uncompressed P-256 — the app encrypts Wi-Fi to it), lost_mode, ice, last_metrics, last_wifi_scan}`.
  - `PUT /api/v1/companion/devices/{device_id}/lost-mode` body `{on: bool, message: str ≤ 64, show_phone: bool, show_telegram: bool, reauth?: {challenge_id, signature}}` — `on=false` requires `reauth`: a fresh `/auth/device/challenge` for the **calling** device signed over `aelys-companion-lost-off-v1\n{target_device_id}\n{nonce}`, else 403 `REAUTH_REQUIRED`. Stores in `lost_mode_json`; sends `command {name:"lost_mode", args}` if online, else appends to `pending_commands_json` (Review Focus 5).
  - `PUT /api/v1/companion/devices/{device_id}/ice` body `{contacts: [{name ≤ 32, phone ≤ 23}] ≤ 2, med_note ≤ 96, show_name: bool}` → stored + `ice_update` command (online or pending).
  - `POST /api/v1/companion/devices/{device_id}/find` → `play_sound`; offline → 409 `DEVICE_OFFLINE` (not queued).
  - `POST /api/v1/companion/devices/{device_id}/wifi` body `{blob: base64url ≤ 512 bytes decoded}` — opaque, never logged or stored; offline → 409 `DEVICE_OFFLINE`.
  - `POST /api/v1/companion/devices/{device_id}/wifi-scan` → `wifi_scan` command; offline → 409; result arrives later in `last_wifi_scan`.
  - Each command carries a uuid `id`; pending ones dedupe by `name` (newest `lost_mode`/`ice_update` replaces the older one).

- [ ] **Step 1: Failing tests:** `test_lost_mode_on_while_offline_is_delivered_on_connect`; `test_lost_mode_off_requires_fresh_reauth` (missing → 403 `REAUTH_REQUIRED`; reused challenge → 403; valid → 200); `test_find_offline_is_409`; `test_wifi_blob_is_forwarded_not_stored_or_logged` (assert DB row and caplog contain no part of the blob); `test_board_cannot_call_owner_commands` (companion token → 403 `DEVICE_SCOPE_DENIED`); `test_other_owner_device_is_404`; `test_state_exposes_public_key`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; `make openapi`; ruff/mypy/bandit.
- [ ] **Step 5: Commit** `feat(companion): relay lost mode, find, ICE and Wi-Fi commands`.

### Task 9: End-to-end test and docs — model: **sonnet**

**Files:**
- Create: `backend/tests/test_companion_e2e.py`
- Modify: `docs/API_CONTRACTS.md` (companion section, pointing to `docs/companion-protocol.md`), `firmware/companion/docs/next-steps.md` (mark the backend items done, list what plan 3 consumes)

- [ ] **Step 1: Test** `test_companion_full_flow`: owner claims setup → board pairs via request/approve/finish → login (no refresh) → channel `ready` + `snapshot` → owner creates a task due tomorrow → board gets a snapshot with it → board `action focus.start` → `action_result ok` and next snapshot has `focus.status == "active"` → owner sets lost mode → board gets `command lost_mode` → owner revokes → socket closes 4403 → `/auth/device/challenge` for the board → 401 `UNAUTHORIZED`.
- [ ] **Step 2:** Run → PASS (if it fails, the failing task is reopened, not patched here).
- [ ] **Step 3:** Full validation: `make test`, ruff, mypy, bandit, `pip-audit`, `alembic upgrade head && alembic check`, `make openapi` with no diff.
- [ ] **Step 4: Commit** `test(companion): cover the full board flow` and `docs(companion): document the companion API`.

---

## Execution notes for the controller

- Task 2 changes `current_principal`, which ~180 routes use: run the full suite in that task, not only the new file.
- Tasks 3–8 build on one package; run them in order (no parallel lanes — they share `api.py`, `models.py`, `access.py`).
- Plan 3 (firmware link + app pages) starts from `docs/companion-protocol.md`; any protocol change after Task 1 must update that file in the same commit.
