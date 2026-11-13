# Aelys Companion — Mac app pairing and management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner opens Settings → Devices in the Mac app (Aelys.app), adds the board over USB with the 6-digit code, and manages it, including the lost-off and unpair re-auth.

**Architecture:** (1) A Mac/Android session signed in by email is upgraded once to a key-bound device through the existing `POST /api/v1/devices/register-key`, so it passes `trusted_device` (no backend change, no weaker auth). (2) The desktop app gets a narrow USB serial bridge limited to the board's USB-Serial/JTAG and to Improv RPC frames; the web `CompanionSerial` uses it through a small port adapter when Web Serial is absent.

**Tech Stack:** Rust (`packages/native-transport`, `apps/desktop/src-tauri`, Tauri 2), `serialport` crate (new, desktop only), TypeScript/React (`apps/web`), Vitest.

**Spec / context:** `docs/superpowers/specs/2026-11-12-esp32-companion-design.md` §4.3, §4.11; plan 3 `docs/superpowers/plans/2026-11-13-companion-link.md` (W1 serial client, W3 native re-auth, W4 Add companion). Cause verified in code: `backend/app/core/native_auth.py:start_session` creates a `Device` with no `public_key`; `backend/app/companion/commands.py:owner_caller` depends on `trusted_device` (`backend/app/core/device_auth.py:199`), which answers 403 `TRUSTED_DEVICE_REQUIRED` for such devices; `native_device_reauth` also needs `Record.device_key`.

## Global Constraints

- No backend change; the trusted-device rule stays. Use `POST /api/v1/devices/register-key` (body `public_key`, `platform`, `display_name`, `proof` = signature over `aelys-device-register-v1\n{owner_id}\n{public_key}`; returns `DeviceSession {access_token, refresh_token, device_id, token_type}`).
- Never log tokens, keys, proofs, Improv frames, Wi-Fi passwords or the pairing secret/code.
- The serial bridge only opens ports whose USB VID/PID is Espressif USB-Serial/JTAG (`0x303A:0x1001`), one port at a time, and only writes complete, checksum-valid Improv **RPC** frames (`"IMPROV"`, version 1, type `0x03`, length ≤ 255). It is desktop-only (not built for Android).
- New dependency `serialport` pinned exactly in `apps/desktop/src-tauri/Cargo.toml`, default features off unless needed on macOS; `Cargo.lock` committed.
- Web: TS strict, no new npm deps; reuse `CompanionSerial.fromPort` (W1) — the bridge looks like a minimal `SerialPort` (`open`, `readable`, `writable`, `close`).
- Copy: only the design's text; any new string is listed in the task report as invented copy.
- Validation before commits: `cargo test --manifest-path packages/native-transport/Cargo.toml` (+ clippy `-D warnings`, `cargo fmt --check`), `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` (or `cargo check` if tests need the app bundle), `pnpm --filter @aelys/web test && pnpm --filter @aelys/web typecheck`.
- Git: branch `feat/companion-mac` in worktree `.worktrees/companion-mac`; Conventional Commits; explicit paths; no push, no merge (owner's yes needed).

## Review Focus

1. **Upgrade fails half-way** (register-key error, network drop, keychain write fails) → the owner stays signed in with the old password session; nothing is lost; the upgrade retries on the next start. (Task M1)
2. **Existing installs** already signed in by email (no `device_key` in the stored record) get upgraded on resume, not only at a fresh login. (Task M1)
3. **The old keyless device** is revoked with the new key-bound session after the switch, so the owner's device list doesn't fill with dead "Aelys Mac" rows. (Task M1)
4. **A non-Aelys USB serial device** or a forged frame from the webview (e.g. raw bytes, a non-RPC Improv type) is refused by the bridge. (Task M2)
5. **Unplugging the board mid-pairing** ends with a clear error in the page, the port handle released, no stuck reader. (Task M2)

---

### Task M1: Key-bound native session — model: **sonnet**

**Files:** Modify `packages/native-transport/src/transport.rs` (login/bootstrap path `establish_login`, resume path `native_resume`/stored-record restore, a new `upgrade_to_device_key`), tests in the same file's test module.

**Interfaces — Produces:** `async fn upgrade_to_device_key(client: &Client, store: &impl Store, session: Session) -> Result<Session, String>` — if `session.record.device_key.is_some()` returns it unchanged; else generates `DeviceKey`, signs the register context, `POST {origin}/api/v1/devices/register-key` with the old access token, builds the new session with the existing `device_session(...)`, persists it (`persist_or_revoke`), then best-effort `POST /api/v1/devices/{old_device_id}/revoke` with the NEW access token; on any error before the persist returns the original session untouched (`Ok(session)`, logged as a code only).

- [ ] **Step 1: Failing tests** (mock server like the existing transport tests): `login_upgrades_to_a_key_bound_device` (register-key called once with a proof that verifies against the posted public key and the owner id from `/me`; stored record now has `device_key` and the new `device_id`; old device revoked with the new token); `resume_upgrades_a_keyless_record`; `upgrade_failure_keeps_the_password_session` (register-key 500 → still signed in with the old record, no revoke call); `keyed_session_is_not_upgraded_again`; `revoke_failure_after_switch_is_ignored`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement; call it at the end of `establish_login` (login and bootstrap) and where a stored record without `device_key` is resumed. Platform/display name: `native_platform()` / `native_display_name()`.
- [ ] **Step 4:** tests, clippy, fmt PASS; `cargo check` of `apps/desktop/src-tauri` and `apps/mobile/src-tauri`.
- [ ] **Step 5: Commit** `fix(native): bind email sign-ins to a device key`.

### Task M2: USB serial bridge for Add companion — model: **sonnet**

**Files:** Create `apps/desktop/src-tauri/src/companion_serial.rs`; modify `apps/desktop/src-tauri/src/lib.rs` (register commands), `apps/desktop/src-tauri/Cargo.toml`/`Cargo.lock`, capabilities only if required (check how other app commands are allowed); create `apps/web/src/lib/companion/nativeSerial.ts`; modify `apps/web/src/lib/companion/serial.ts` (`supported()`, `request()`), `apps/web/src/views/settings/devices/AddCompanion.tsx` (native Mac path shows the flow instead of the hint; Android keeps the hint), `apps/web/src/lib/nativeTransport.ts` if the invoke wrapper lives there; tests `apps/web/src/tests/companion-native-serial.test.ts`, Rust unit tests in `companion_serial.rs`; `firmware/companion/docs/link-checklist.md` (Mac pairing path in §2).

**Interfaces — Produces (Rust, Tauri commands):** `companion_serial_ports() -> Vec<String>` (paths of 0x303A:0x1001 ports); `companion_serial_open(path: String) -> Result<(), String>` (path must be in the current filtered list; replaces any open port); `companion_serial_write(bytes: Vec<u8>) -> Result<(), String>` (whole valid Improv RPC frames only, may contain several frames back to back? — no: exactly one frame per call); `companion_serial_read(max: u32) -> Result<Vec<u8>, String>` (≤ 100 ms blocking read in `spawn_blocking`, empty vec on timeout, `"DISCONNECTED"` when the port is gone); `companion_serial_close()`. Pure helpers with unit tests: `is_companion_port(vid, pid) -> bool`, `valid_improv_rpc(frame: &[u8]) -> bool`.
**(TS):** `class NativeSerialPort` with `open({ baudRate })`, `readable: ReadableStream<Uint8Array>` (polls `companion_serial_read`), `writable: WritableStream<Uint8Array>` (one frame per write → `companion_serial_write`), `close()`; `CompanionSerial.supported()` is true for Web Serial or for the desktop native host when `companion_serial_ports` exists; `CompanionSerial.request()` on native picks the single Aelys port (none → `CompanionError('NOT_AELYS')` with the page's existing step-1 text; several → the first, documented).

- [ ] **Step 1: Failing tests:** Rust `accepts_only_espressif_jtag`, `rejects_non_rpc_or_bad_checksum_frames` (raw bytes, type 0x01/0x04, truncated, bad checksum, > 265 bytes); TS `native port round-trips a pairBegin through CompanionSerial`, `unplug mid-request ends with an error and closes`, `supported() is true on the Mac host and false on Android`, `AddCompanion runs the pairing flow on the Mac host`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement. Never log frame bytes. The Improv Wi-Fi RPC (with the owner-typed password) passes through as an opaque frame.
- [ ] **Step 4:** Rust tests + `cargo check` desktop; web tests + typecheck PASS.
- [ ] **Step 5: Commit** `feat(desktop): pair the companion over USB from the Mac app` (+ `docs(firmware): add the Mac pairing path` for the checklist).
