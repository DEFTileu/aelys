# Aelys Companion — link, pairing and app pages (plan 3 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner pairs the board from the web over USB, the board signs in by its P-256 key, keeps a `wss://` channel to AELYS, shows the live snapshot on three swipeable home screens (Today ← Aelys → Focus) with focus / task / notification actions and an offline cache, and obeys the §4.11 commands (lost mode, find, ICE, Wi-Fi from the phone) driven from Settings → Devices → Aelys.

**Architecture:** Firmware: pure C logic (JSON protocol codec, link state machine, triple buffer, gestures, store codecs) lives in `components/logic` and is tested on the host; new IDF components `identity` (PSA crypto key, SAS, ECIES) and `link` (HTTPS sign-in, WebSocket, command handlers) run on core 0 and hand state to the `ui` task through `lv_port_post` events plus lock-free triple buffers. Web: `apps/web/src/lib/companion/` (Improv over Web Serial, ECIES, API) and a `devices` settings panel built only from the owner's design frames. A small additive backend change (protocol v1.1) fills the gaps the design needs.

**Tech Stack:** ESP-IDF v6.1 (mbedTLS **4.1.0 — PSA Crypto API only**), C11, LVGL 9.6.0, jsmn (vendored), `espressif/esp_websocket_client`, `espressif/es8311`; React 19 + TypeScript + Vitest, WebCrypto, Web Serial; Rust (`packages/native-transport`) for native re-auth; FastAPI for the v1.1 additions.

**Spec:** `docs/superpowers/specs/2026-11-12-esp32-companion-design.md` (§4.3, §4.5, §4.6, §4.11). Contract: `docs/companion-protocol.md` (plan 2, DECIDED 2026-11-13; on branch `feat/companion-backend` until merged). Plan 1 code: `firmware/companion/`. Carry-over: `firmware/companion/docs/next-steps.md`, `firmware/companion/docs/budgets.md`. Plan 2: `docs/superpowers/plans/2026-11-13-companion-backend.md`.

**Design sources (only these; no new UI):** artifact `https://claude.ai/artifact/Ld69nUYL4eDZs5K3Jh8CKe` — read with the Artifact tool (`action: read`, `path`):
- `project/ACTUAL AELYS Companion App.dc.html` — app pages: frames 1 (Devices, Aelys overview), 2 (Lost mode setup / on / confirm), 3 (Emergency; SOS frames are a proposal — not built), 4 (Wi-Fi saved / add / sending / wrong password), 5 (Device settings), 6 (web "Add companion" in the desktop settings layout).
- `project/ACTUAL AELYS Companion.dc.html` — device screens: 1 (Today · обзор, Элис · главный экран, Focus · идёт), 3 (Focus · пауза, Focus · сессия завершена), 4 (Уведомления · входящие), 9 (Первое включение, Сопряжение · код, Нет связи), 10 (Режим потери ± нажата кнопка, Найти Элис, Wi-Fi с телефона, Wi-Fi · неверный пароль). Colours/tokens at the top of that page.
- `apps/web` conventions: `views/settings/*` (`GROUPS`, `?section=` URL, `ui.tsx` rows/switches), `lib/api.ts` (`getSharedApiClient().request`), tests like `tests/settings-accounts.test.tsx`.

## Decisions for the owner to confirm (the plan is built on them)

1. **Pairing is driven by the web page over USB, in the design's order USB → code → Wi-Fi.** The page gets the board's public key over Improv, itself calls `POST /pairing/request` and, after the owner types the 6 digits shown on the board, `POST /pairing/{id}/approve` (existing API: approve takes the typed SAS). It hands the returned `device_id` to the board over USB. The board never calls `/pairing/finish`; it signs in with `challenge → login` once online. Why: the board needs no network to pair, and approve → board online can take longer than the 120 s pairing TTL. Spec §4.3 had the board call request/finish itself.
2. **The owner types the board's code** (design frame 6 + existing approve API) rather than comparing two codes on screen.
3. **Protocol v1.1, additive** (Task B1): snapshot `today_done/today_total/other_unread_count`; `hello.contacts`; metrics `battery_pct/charging/heap_at_connect_min`; message `wifi_state`; commands `settings`, `wifi_remove`, `wifi_order`, `restart`, `unpair`; richer `lost_mode`/`ice_update` args; command results visible to the app. Without them the design pages (battery, saved networks, relation, email, unpair) cannot be filled.
4. **Inferred bits the design frames don't show:** the Focus screen with no session shows "Focus · 25 min session" + hint "Start" (text from the menu-wheel frame); the paused frame adds a secondary line "Hold to stop". Owner may veto; both are one-line changes.

## Global Constraints

- ESP-IDF **v6.1**, C11 only; no C++, Arduino, Brookesia, BLE, cJSON, `esp_lvgl_port`. JSON: vendored **jsmn** (MIT, no allocation). Crypto: **PSA API only** (`psa_generate_key`, `psa_sign_message`, `psa_raw_key_agreement`, `psa_key_derivation_*` with `PSA_ALG_HKDF(PSA_ALG_SHA_256)`, `psa_aead_decrypt` with `PSA_ALG_GCM`, `psa_mac_compute` with `PSA_ALG_HMAC(PSA_ALG_SHA_256)`); legacy `mbedtls_ecdh_*`/`mbedtls_pk_*` do not exist in mbedTLS 4.1.
- New registry deps pinned exactly in `main/idf_component.yml` (latest release that builds on IDF 6.1, recorded in the commit); `dependencies.lock` committed; `sdkconfig` never committed.
- Only the `ui` task calls LVGL. Other tasks → `lv_port_post` (64-byte events) + triple buffers for anything larger. No malloc, locks or logs in the render path.
- Board secrets: no refresh token; access token only in the `Authorization` header and in RAM; `api_url` must start with `https://` (sockets are `wss://` derived from it); TLS via `esp_crt_bundle_attach` with `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_CMN=y`; no TLS before SNTP has set the clock (year ≥ 2025).
- Never log or write to a tracked file: pairing secret, SAS digits, access token, private key, Wi-Fi password, decrypted blob, owner contacts (`owner_contact.local.h` stays git-ignored; repo is PUBLIC). Buffers that held them are `explicit_bzero`ed.
- NVS namespace `aelys`. Existing keys `owner`, `wifi`, `lost`; new `pair` (device_id, api_url, private key — unencrypted until the owner decides on NVS encryption, spec §4.8), `snap`, `settings`. Every blob: `[version][payload][CRC32]` via `store_codec`.
- Budgets (spec §4.6, `firmware/companion/docs/budgets.md`): free internal heap ONLINE ≥ 80 KB (steady), image ≤ 2 MB, touch → screen ≤ 50 ms, 60 fps.
- `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y` (exists in IDF 6.1 `components/mbedtls/Kconfig:193`) is set **before** the first TLS code lands.
- Device copy English, character "Aelys". App copy = the design's English text, verbatim.
- Web: TS strict, no new npm dependencies; companion writes use `queueOnOffline: false` (commands are live, never replayed from the outbox).
- Protocol: `docs/companion-protocol.md`; any change bumps the version in that file in the same commit (Task B1 makes it v1.1).
- Board: one USB port shared with plan 4 → **board tasks run strictly one at a time**, in the order of "Board slots" below. Standing yes covers reboot and app/OTA flashing; never `erase-flash` or eFuse commands. Owner's Wi-Fi password and the 6-digit code are typed by the owner, never by an agent.
- Git: branch `feat/companion-link` in worktree `.worktrees/companion-link` (copy git-ignored `firmware/companion/main/owner_contact.local.h` in); Conventional Commits, explicit paths. Before B1 and F7, merge `main` (with plan 2) into the branch. Builds for the owner's board come from fresh `main` after merge (owner's rule).
- Validation before each commit: firmware `cd firmware/companion && idf.py build` and `cmake -S sim -B sim/build && cmake --build sim/build && ctest --test-dir sim/build --output-on-failure`; web `pnpm --filter @aelys/web test && pnpm --filter @aelys/web typecheck`; Rust `cargo test --manifest-path packages/native-transport/Cargo.toml`; backend per plan 2's Global Constraints.

## Review Focus

1. **Backend down, 5xx, 429, DNS or TLS failure while signing in** → board keeps its pairing and backs off 1 s → 60 s; only `POST /auth/device/challenge` → 401 `UNAUTHORIZED` wipes it. (Task F4 `test_only_challenge_401_wipes`.)
2. **Lost mode on and a stranger plugs in USB or pokes the board** → `PAIR_BEGIN` refused, swipes/taps never leave the lost screen, ICE card shows the ICE fields, all survives reboot. (Tasks F3 `test_ice_update_while_lost_updates_shown`, F6 `test_pair_begin_refused_in_lost_mode`, F8 `test_swipes_ignored_in_lost_mode`.)
3. **Hostile or odd server JSON** — missing/null fields, unknown types, 4 KB+ frame, titles with emoji/Cyrillic cut mid-character, `"` and `\` in SSIDs → parser rejects or truncates on a UTF-8 boundary, never crashes. (Task F2 corpus test.)
4. **Wi-Fi from the phone with a wrong password** → board falls back to its previous network, the `WIFI_FAILED` ack arrives after reconnect, the app shows "Wrong password for X". (Tasks F9b, B1 `test_late_ack_recorded`, W6.)
5. **Heap at reconnect** (Wi-Fi bring-up dip to ~62 KB + TLS) → no TLS allocation failure over a 30-minute run with forced reconnects; steady minimum ≥ 80 KB. (Task F7 step 5.)

## File structure

Firmware (`firmware/companion/`):
- `components/logic/` (pure C, host-tested): `third_party/jsmn/{jsmn.h,LICENSE}`; `include/codec_util.h` + `codec_util.c` (base64url, JSON string escape, UTF-8-safe copy, ISO-8601 → epoch, UUID v4 text, Wi-Fi plaintext parse); `include/snap.h` (snapshot types); `include/proto.h` + `proto.c` (parse server messages, build board messages); `include/tribuf.h` + `tribuf.c`; `include/link_fsm.h` + `link_fsm.c`; `include/gesture.h` + `gesture.c`; modified `owner.h/owner.c`, `store_codec.h/.c`, `improv.h/.c`, `screen_fsm.h/.c`, `ui_events.h`.
- `components/identity/` (new, IDF): `include/identity.h`, `identity.c`.
- `components/link/` (new, IDF): `include/link.h`, `link.c` (task + FSM driver), `link_http.c`, `link_ws.c`, `link_cmd.c`.
- `components/net/net_improv.c` (vendor RPCs), `net_wifi.c` (scan, list ops), `include/net.h`.
- `components/board/`: `board_audio.c` (new, ES8311), `board_display.c` (brightness), `board_power.c` (battery), `board_input.c` (gestures, buttons).
- `components/ui/`: `scr_today.c`, `scr_focus.c`, `scr_inbox.c`, `scr_pair.c`, `scr_toast.c` (find / Wi-Fi / hint overlays), `mood_rules.c` (new); modified `screens.c`, `scr_home.c`, `include/ui.h`, `include/ui_screens_priv.h`, `fonts/*`.
- `main/app_main.c`, `main/store_nvs.{c,h}`, `main/metrics.c`, `main/idf_component.yml`, `sdkconfig.defaults`, `main/Kconfig.projbuild`.
- `sim/`: new tests listed per task; `tools/companion_vectors.py` (+ generated `sim/vectors.h`, `apps/web/src/tests/fixtures/companion-vectors.json`).

Web (`apps/web/src/`): `lib/companion/{improv.ts,serial.ts,webserial.d.ts,ecies.ts,api.ts,types.ts}`; `views/settings/devices/{DevicesPanel.tsx,AddCompanion.tsx,CompanionOverview.tsx,LostModePage.tsx,EmergencyPage.tsx,WifiPage.tsx,DeviceSettingsPage.tsx,ReauthSheet.tsx,RoundPreview.tsx,devices.css}`; `views/settings/useSettings.ts`, `SettingsView.desktop.tsx`, `SettingsView.mobile.tsx`; `lib/nativeTransport.ts`; tests `tests/companion-*.test.ts(x)`.

Native: `packages/native-transport/src/transport.rs` (+ command registration in `apps/desktop/src-tauri/src/lib.rs`, `apps/mobile/src-tauri/src/lib.rs`).

Backend (Task B1 only): `backend/app/companion/{snapshot.py,commands.py,channel.py,api.py,models.py}`, `backend/alembic/versions/0051_companion_v11.py`, `backend/tests/test_companion_v11.py`, `docs/companion-protocol.md`.

## Task map

| Task | Model | Board | Before plan 2 lands? | Depends on |
|---|---|---|---|---|
| F1 Codec utilities | haiku | no | yes | — |
| F2 Protocol codec | sonnet | no | yes (fixtures from the protocol doc) | F1, F3 |
| F3 Owner/lost contract, triple buffer, Cyrillic | sonnet | no | yes | — |
| F4 Link state machine | sonnet | no | yes | — |
| F5 Identity (key, SAS, ECIES) | sonnet | **slot 1** | yes | F1 |
| F6 USB pairing RPCs + pair screen | sonnet | **slot 2** | yes | F3, F5 |
| W1 Improv over Web Serial | sonnet | no | yes | — |
| W2 Companion API, ECIES, web re-auth | sonnet | no | yes (mocks) | W1 vectors (F5 step 1) |
| W3 Native re-auth op | sonnet | no | yes (unit tests) | — |
| W4 Add companion page | sonnet | no (owner check in F7) | yes (mocks) | W1, W2 |
| B1 Backend protocol v1.1 | sonnet | no | **no** — on top of merged plan 2 | plan 2 |
| F7 Link: sign-in + channel | sonnet | **slot 3** | **no** — needs plan 2 deployed | F2, F4, F5, F6, W4 |
| F8 Home screens, actions, offline cache | sonnet | **slot 4** | sim part yes; board check no | F2, F3, F7 |
| F9a Lost / ICE / settings / restart / unpair commands | sonnet | **slot 5** | logic yes; board no | F7, F8, B1 |
| F9b Wi-Fi commands | sonnet | **slot 6** | logic yes; board no | F7, B1 |
| F9c Find (ES8311 sound) | sonnet | **slot 7** | board bring-up yes; command no | F7 |
| W5 Devices list, overview, lost mode pages | sonnet | no | yes (mocks of B1 shapes) | W2, W3 |
| W6 Emergency, Wi-Fi, device settings pages | sonnet | no | yes (mocks of B1 shapes) | W2 |
| T1 End-to-end with the owner + docs | sonnet | **slot 8** | no | all |

Board slots are sequential and must not overlap plan 4's board tasks.

---

### Task F1: Codec utilities — model: **haiku** · board: no · pre-plan-2: yes

**Files:**
- Create: `firmware/companion/components/logic/third_party/jsmn/jsmn.h` (+ `LICENSE`, from zserge/jsmn tag v1.1.0), `components/logic/include/codec_util.h`, `components/logic/codec_util.c`, `sim/test_codec_util.c`
- Modify: `components/logic/CMakeLists.txt` (include `third_party/jsmn`), `sim/CMakeLists.txt` (add test to the logic test loop)

**Interfaces — Produces (`codec_util.h`):**
```c
size_t b64url_encode(const uint8_t *in, size_t n, char *out, size_t cap); /* no padding, NUL-terminated; 0 if cap too small */
int    b64url_decode(const char *in, uint8_t *out, size_t cap);           /* bytes written, -1 on bad char/length/overflow; accepts no padding */
size_t json_escape(const char *in, char *out, size_t cap);                /* escapes " \ and < 0x20 as \uXXXX; 0 if it does not fit */
size_t utf8_copy(char *dst, size_t cap, const char *src, size_t n);       /* copies ≤ n bytes, never splits a code point, always NUL-terminates; returns bytes copied */
bool   iso8601_to_epoch(const char *s, size_t n, int64_t *out);           /* "YYYY-MM-DDTHH:MM:SS[.fff](Z|+00:00)" only; false otherwise */
void   uuid4_format(const uint8_t rnd[16], char out[37]);                 /* sets version/variant bits */
bool   wifi_plain_parse(const uint8_t *p, size_t n, char ssid[33], char pass[65]); /* [ssid_len][ssid][pass_len][pass], ssid 1..32, pass 0..64, exact length */
```
`#define JSMN_STATIC` + `JSMN_PARENT_LINKS` once in `proto.c` (Task F2), header-only elsewhere.

- [ ] **Step 1: Failing tests** `test_codec_util.c`: `test_b64url_roundtrip_0_to_70_bytes`; `test_b64url_rejects_plus_slash_and_bad_len` (`"ab+"`, `"a"` → -1); `test_json_escape_quotes_backslash_ctrl` (`a"b\c\n` → `a\"b\\c\u000a`); `test_utf8_copy_never_splits` (`"Привет"` with n=3 → `"П"`, `"😀x"` with n=3 → `""`); `test_iso8601` (`2026-11-13T09:30:00Z` → 1794562200; with `.123` and `+00:00` same; `2026-13-01T00:00:00Z` → false; `+05:00` → false); `test_uuid4_bits` (char 14 == '4', char 19 ∈ `89ab`); `test_wifi_plain` (valid; ssid_len 0 → false; trailing byte → false; pass 65 → false).
- [ ] **Step 2:** `ctest --test-dir sim/build -R codec_util` → FAIL (not built).
- [ ] **Step 3: Implement** `codec_util.c` (days-from-civil for ISO-8601; no `timegm`).
- [ ] **Step 4:** test PASS; `idf.py build` PASS.
- [ ] **Step 5: Commit** `feat(firmware): add codec helpers and vendor jsmn`.

### Task F2: Protocol codec — model: **sonnet** · board: no · pre-plan-2: yes

**Files:**
- Create: `components/logic/include/snap.h`, `components/logic/include/proto.h`, `components/logic/proto.c`, `sim/test_proto.c`, `sim/proto_corpus/*.json` (one message per file)

**Interfaces — Consumes:** F1. **Produces:**
```c
/* snap.h — every string NUL-terminated, cut with utf8_copy */
typedef struct { char id[40]; char title[65]; int64_t due; } snap_task_t;
typedef struct { char id[40]; char title[65]; int64_t starts, ends; bool all_day, has_end; } snap_event_t;
typedef struct { char id[40]; char kind[24]; char title[65]; int64_t created; } snap_notice_t;
typedef enum { FOCUS_NONE, FOCUS_ACTIVE, FOCUS_PAUSED } focus_status_t;
typedef struct { char id[40]; uint8_t status; char mode[16]; int64_t started; int32_t elapsed_s; } snap_focus_t;
typedef struct { int64_t generated; bool has_task, has_event; snap_task_t task; snap_event_t event;
                 int16_t overdue, unread, other_unread /* -1 = server v1 */, today_done, today_total /* -1 = v1 */;
                 uint8_t n_notices; snap_notice_t notices[5]; snap_focus_t focus; } snap_t;
/* proto.h */
typedef enum { ACT_NOTIFICATION_READ, ACT_FOCUS_START, ACT_FOCUS_PAUSE, ACT_FOCUS_RESUME, ACT_FOCUS_STOP, ACT_TASK_COMPLETE } act_kind_t;
typedef enum { CMD_LOST_MODE, CMD_PLAY_SOUND, CMD_ICE_UPDATE, CMD_WIFI_ADD, CMD_WIFI_SCAN, CMD_SETTINGS, CMD_WIFI_REMOVE,
               CMD_WIFI_ORDER, CMD_RESTART, CMD_UNPAIR, CMD_UNKNOWN } cmd_name_t;
typedef enum { MSG_READY, MSG_HB_ACK, MSG_SNAPSHOT, MSG_ACTION_RESULT, MSG_COMMAND, MSG_ERROR, MSG_UNKNOWN } msg_type_t;
typedef struct { msg_type_t type; char id[40]; /* action/command id; ready: device_id */
    union { snap_t snap; struct { bool ok; char error[24]; } result; struct { char code[32]; } error;
            struct { cmd_name_t name; char raw_name[16]; union { lost_cmd_t lost; ice_cmd_t ice; char blob[704];
                     struct { uint8_t brightness; } settings; char ssid[33]; struct { uint8_t n; char ssid[5][33]; } order; } a; } cmd; } u;
} proto_msg_t; /* ~1.1 KB: callers keep it static, never on a task stack */
bool   proto_parse(const char *json, size_t len, proto_msg_t *out); /* false: not JSON, no "type", len > 4096, or a known type with missing/invalid required fields */
size_t proto_hello(char *buf, size_t cap, const char *fw, const char *board, const char *phone, const char *telegram);
size_t proto_heartbeat(char *buf, size_t cap);
size_t proto_metrics(char *buf, size_t cap, const proto_metrics_t *m);  /* proto_metrics_t: the 5 v1 fields + battery_pct (-1 = omit), charging, heap_at_connect_min */
size_t proto_action(char *buf, size_t cap, const char id[37], act_kind_t k, const char *target_id /* NULL for focus.* */, const char *focus_mode /* NULL = omit */);
size_t proto_command_ack(char *buf, size_t cap, const char *id, bool ok, const char *error_code /* NULL when ok */);
size_t proto_wifi_scan_result(char *buf, size_t cap, const char *id, const wifi_seen_t *nets, int n); /* wifi_seen_t {char ssid[33]; int8_t rssi; bool secure;} */
size_t proto_wifi_state(char *buf, size_t cap, const wifi_list_t *saved, const char *current /* NULL → null */);
const char *act_kind_str(act_kind_t k); /* "notification.read", "focus.start", ... exactly as in the contract */
```
`lost_cmd_t` / `ice_cmd_t` come from `owner.h` (Task F3). `wifi_seen_t` and `proto_metrics_t` are defined in `proto.h`. `hello` keys `fw_version`, `board` (`"waveshare-amoled-1.75c"`), `features` (`["display","speaker","wifi_scan"]`), `contacts` (v1.1, B1).

- [ ] **Step 1: Failing tests** `test_proto.c`, data from `sim/proto_corpus/` (copy every example from `docs/companion-protocol.md` v1 verbatim, plus v1.1 examples from Task B1's Interfaces block):
  - `test_parses_every_contract_example` — each server example parses with the right `type` and fields (snapshot: `task.due == iso("2026-11-13T12:00:00Z")`, `focus.status == FOCUS_ACTIVE`, `n_notices == 1`, v1 snapshot → `today_total == -1`).
  - `test_snapshot_nulls_and_missing_optional` — `next_task: null`, `focus: null`, no `notices` → parsed, `has_task == false`, `n_notices == 0`.
  - `test_more_than_5_notices_keeps_first_5`.
  - `test_titles_cut_on_utf8_boundary` — 100 × "Ж" title → 32 "Ж" (64 bytes), valid UTF-8.
  - `test_rejects` — not JSON; no `type`; 4097-byte input; `action_result` without `id`; `command` with unknown `name` → parses with `CMD_UNKNOWN` (board must ack `UNSUPPORTED`), not rejected.
  - `test_built_messages_parse_as_json` — every builder output re-tokenises with jsmn and contains exact keys/values; `proto_action(..., ACT_TASK_COMPLETE, "t-1", NULL)` == `{"type":"action","id":"<id>","kind":"task.complete","payload":{"task_id":"t-1"}}`.
  - `test_wifi_state_escapes_ssid` — SSID `a"b\c` round-trips through `proto_wifi_state` and jsmn.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** `proto.c` (jsmn with a static 256-token array; datetime fields via `iso8601_to_epoch`; unknown fields ignored).
- [ ] **Step 4:** PASS; `idf.py build` PASS.
- [ ] **Step 5: Commit** `feat(firmware): parse and build companion channel messages`.

### Task F3: Owner/lost contract, triple buffer, Cyrillic glyphs — model: **sonnet** · board: no · pre-plan-2: yes

Covers carry-over items 1–3 from `next-steps.md`.

**Files:**
- Create: `components/logic/include/tribuf.h`, `components/logic/tribuf.c`, `sim/test_tribuf.c`, `sim/test_owner.c`
- Modify: `components/logic/include/owner.h`, `owner.c`, `store_codec.h/.c` (`STORE_VERSION 2`), `sim/test_store.c`, `components/ui/screens.c`, `components/ui/include/ui.h`, `components/ui/scr_lost.c`, `scr_ice.c`, `main/app_main.c`, `components/ui/fonts/*` + `fonts/README.md`, `components/ui/CMakeLists.txt` if a font is added, `sim/test_screens.c`

**Interfaces — Produces:**
```c
/* tribuf.h — single writer task, single reader task, lock-free (C11 atomics) */
typedef struct { _Atomic uint8_t mid; uint8_t back, front; void *slot[3]; } tribuf_t; /* mid: bits0-1 index, bit7 fresh */
void tribuf_init(tribuf_t *t, void *s0, void *s1, void *s2);
void *tribuf_back(tribuf_t *t);            /* writer fills this slot... */
void tribuf_publish(tribuf_t *t);          /* ...then publishes it */
const void *tribuf_latest(tribuf_t *t, bool *fresh); /* reader: newest published slot, stable until its next call */
/* owner.h additions (owner_info_t v2) */
char email[49]; char ice_rel[2][17]; uint8_t show; /* OWNER_SHOW_NAME 1, _CONTACTS 2, _MED 4, _PHONE 8, _TELEGRAM 16, _EMAIL 32 */
uint8_t qr; /* QR_TELEGRAM 0, QR_PHONE 1, QR_NONE 2 */
typedef struct { bool on; char message[65]; bool show_phone, show_telegram, show_email; char email[49]; uint8_t qr; } lost_cmd_t;
typedef struct { char owner_name[33]; uint8_t n; char name[2][33], rel[2][17], phone[2][24]; char med_note[97];
                 bool show_name, show_contacts, show_med; } ice_cmd_t;
/* ICE fields = name, med_note, ice_name, ice_rel, ice_phone, show&(NAME|CONTACTS|MED). */
void owner_apply_ice(owner_info_t *owner, lost_state_t *lost, const ice_cmd_t *c);  /* writes ICE fields to owner and, if lost->on, to lost->shown too */
void owner_apply_lost(lost_state_t *lost, const owner_info_t *owner, const lost_cmd_t *c); /* on: shown = factory contacts (owner_defaults) filtered by show_*, message, email, qr + owner's ICE fields; off: lost->on = false */
/* ui.h: the UI owns the buffers; producers write then post the event (no pointer in the event any more) */
extern tribuf_t ui_owner_tb;   /* owner_info_t — what lost/ICE screens show: lost.on ? lost.shown : owner */
extern tribuf_t ui_snap_tb;    /* snap_t (Task F8 uses it) */
/* UI_EV_OWNER: len 0, reader calls tribuf_latest(&ui_owner_tb) */
```

- [ ] **Step 1: Failing tests:**
  - `test_tribuf.c`: `test_reader_sees_latest_publish`; `test_no_fresh_without_publish`; `test_stress_two_threads` (pthread writer publishes 1..1 000 000, filling a 512-byte slot with the counter; reader asserts every read slot is uniform and counters never go backwards).
  - `test_owner.c`: `test_lost_on_keeps_ice_fields` (owner has 2 ICE contacts + med note → after `owner_apply_lost(on)` `lost.shown` has them); `test_ice_update_while_lost_updates_shown`; `test_ice_update_while_not_lost_leaves_shown`; `test_lost_hides_unselected_contacts` (`show_phone=false` → `shown.phone[0]==0`); `test_lost_off_clears_flag_only`.
  - `test_store.c`: `test_v1_blob_falls_back_to_defaults` (v1 blobs only ever held factory data, so fallback is safe) and the v2 round-trip.
  - `test_screens.c`: `test_cyrillic_and_kazakh_render` — lost + ICE with names "Айгерим Сапарова", "Әсем Құрманғали", relation "Сестра": no placeholder glyph boxes (assert `lv_font_get_glyph_dsc` succeeds for every code point of each label's text) and every lit pixel within radius 233.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** tribuf/owner/codec; switch `UI_EV_OWNER` to the triple buffer in `screens.c` and `app_main.c` (boot writes `lost.on ? lost.shown : owner` into `tribuf_back(&ui_owner_tb)`, publishes, posts). ICE screen shows relation under each name and respects `show` bits (design frame "Экстренная карта (ICE)").
- [ ] **Step 4: Fonts** — regenerate `inter_16/20/24/28` with ranges `0x20-0x7E,0xB7,0x2026,0x2014,0x2018,0x2019,0x201C,0x201D,0x400-0x45F,0x492,0x493,0x49A,0x49B,0x4A2,0x4A3,0x4AE-0x4B1,0x4BA,0x4BB,0x4D8,0x4D9,0x4E8,0x4E9` using the commands in `fonts/README.md` (update its table and command). `idf.py size` → image ≤ 2 MB; record the new size.
- [ ] **Step 5:** all ctest PASS; `companion_sim --shot lost|ice` with the Cyrillic fixture — attach both.
- [ ] **Step 6: Commit** `fix(firmware): pass owner data through a triple buffer` · `feat(firmware): keep ICE fields in the lost-mode record` · `feat(firmware): add Cyrillic and Kazakh glyphs`.

### Task F4: Link state machine — model: **sonnet** · board: no · pre-plan-2: yes

**Files:** Create `components/logic/include/link_fsm.h`, `components/logic/link_fsm.c`, `sim/test_link_fsm.c`.

**Interfaces — Produces:**
```c
typedef enum { LS_UNPAIRED, LS_WAIT_NET, LS_LOGIN, LS_CONNECT, LS_ONLINE, LS_BACKOFF, LS_CHECK, LS_REPLACED } link_state_t;
typedef enum { LE_PAIRED, LE_NET_UP, LE_NET_DOWN, LE_LOGIN_OK, LE_LOGIN_REJECTED /* 401/403 */, LE_LOGIN_FAIL /* net, TLS, 5xx, 429 */,
               LE_WS_OPEN, LE_WS_CLOSED /* + close code, 0 = no code */, LE_CHALLENGE_UNKNOWN /* challenge → 401 UNAUTHORIZED */,
               LE_CHALLENGE_OK, LE_CHALLENGE_FAIL /* anything else */, LE_TIMER, LE_UNPAIR } link_event_t;
typedef enum { LA_NONE, LA_LOGIN, LA_CONNECT, LA_CHECK, LA_WIPE_PAIRING, LA_CLOSE } link_action_t;
typedef struct { link_state_t st; uint32_t backoff_ms; uint8_t login_rejects; } link_fsm_t;
void link_fsm_init(link_fsm_t *f, bool paired);
/* Returns the action to run; *wait_ms > 0 means arm LE_TIMER after that delay. rnd = esp_random() for jitter. */
link_action_t link_next(link_fsm_t *f, link_event_t ev, int close_code, uint32_t rnd, uint32_t *wait_ms);
```
Rules (contract "Close codes"): `4401` → LA_LOGIN; `4403` → LA_CHECK; `4000` → LS_REPLACED (no reconnect until LE_NET_DOWN→LE_NET_UP or reboot); other closes / LE_LOGIN_FAIL / LE_CHALLENGE_FAIL → LS_BACKOFF with 1 s × 2ⁿ capped at 60 s, ±20 % jitter, reset on LE_WS_OPEN; LE_LOGIN_REJECTED → LA_CHECK; LE_CHALLENGE_OK after a rejected login → LA_LOGIN, but a 3rd consecutive rejection → backoff; **only** LE_CHALLENGE_UNKNOWN or LE_UNPAIR → LA_WIPE_PAIRING → LS_UNPAIRED.

- [ ] **Step 1: Failing tests:** `test_paired_boot_waits_for_net_then_logs_in`; `test_4401_relogins_without_check`; `test_4403_checks_then_relogins_when_known`; `test_only_challenge_401_wipes` (feed every other event incl. LE_LOGIN_REJECTED ×10, LE_CHALLENGE_FAIL, closes 1006/1011/4401/4403 → never LA_WIPE_PAIRING); `test_backoff_doubles_caps_and_jitters` (1, 2, 4 … 60 s ±20 %); `test_open_resets_backoff`; `test_4000_stays_replaced_until_net_cycles`; `test_net_down_from_any_state_waits`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(firmware): add the link state machine`.

### Task F5: Identity — key, SAS, ECIES — model: **sonnet** · board: **slot 1** · pre-plan-2: yes

**Files:**
- Create: `tools/companion_vectors.py`, `sim/vectors.h` (generated), `apps/web/src/tests/fixtures/companion-vectors.json` (generated), `components/identity/{CMakeLists.txt,include/identity.h,identity.c}`
- Modify: `components/logic/include/store_codec.h`, `store_codec.c` (pair record), `sim/test_store.c`, `main/store_nvs.{c,h}`, `main/app_main.c`, `main/Kconfig.projbuild` (`AELYS_IDENTITY_SELFTEST` bool, default n), `sdkconfig.defaults` (`CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y`, `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_CMN=y`)

**Interfaces — Produces:**
- Fixed schemes (both firmware and web use exactly these):
  - **SAS** = `HMAC-SHA256(key = secret UTF-8, msg = "aelys-sas-v1|" + pairing_id + "|" + pub65)`, first 4 bytes big-endian mod 1 000 000, zero-padded to 6 digits — identical to `backend/app/core/device_auth.py:sas_code`.
  - **Login signature** over `aelys-device-login-v1\n{device_id}\n{nonce}`: ES256, raw r‖s (64 bytes) base64url.
  - **Wi-Fi ECIES blob** = `0x01 ‖ eph_pub(65, uncompressed) ‖ nonce(12) ‖ ciphertext ‖ tag(16)`; `z` = ECDH(eph, device) x-coordinate (32 B); `key` = HKDF-SHA256(ikm = z, salt = eph_pub ‖ device_pub, info = "aelys-wifi-v1", L = 32); AES-256-GCM, AAD = `device_id` UTF-8; plaintext per `wifi_plain_parse`. Max decoded size 192 B.
- `store_codec`: `typedef struct { char device_id[40]; char api_url[129]; uint8_t priv[32]; } pair_rec_t;` + `store_encode_pair/store_decode_pair`; `store_nvs`: `bool store_load_pair(pair_rec_t*)`, `esp_err_t store_save_pair(const pair_rec_t*)`, `esp_err_t store_erase_pair(void)` (key `pair`).
- `identity.h` (persistence injected, like `net_store_t`):
  ```c
  typedef struct { bool (*load)(pair_rec_t *); esp_err_t (*save)(const pair_rec_t *); esp_err_t (*erase)(void); } identity_store_t;
  esp_err_t identity_init(const identity_store_t *st);          /* psa_crypto_init, load record, import key as volatile */
  bool identity_paired(void);
  const char *identity_device_id(void);  const char *identity_api_url(void);
  esp_err_t identity_pub_b64(char out[88]);                      /* current key (or pending key during pairing) */
  esp_err_t identity_pair_begin(const char *api_url);            /* new key in RAM only; ESP_ERR_INVALID_ARG unless api_url starts with "https://" and ≤ 128 */
  esp_err_t identity_pair_code(const char *secret, const char *pairing_id, char sas[7]); /* requires a pending key */
  esp_err_t identity_pair_commit(const char *device_id);         /* one NVS write: key + device_id + api_url; replaces any old pairing */
  void      identity_pair_cancel(void);
  esp_err_t identity_sign(const char *msg, char sig_b64[87]);
  esp_err_t identity_wifi_decrypt(const uint8_t *blob, size_t n, char ssid[33], char pass[65]);
  esp_err_t identity_wipe(void);                                  /* erase record + destroy key */
  ```

- [ ] **Step 1: Vectors** — `tools/companion_vectors.py` (Python `cryptography`, run with `PYTHONPATH=backend .venv/bin/python -I tools/...` from the repo root so it imports `app.core.device_auth.sas_code` and `verify_signature`) writes: device key pair, `device_id`, a secret, a `pairing_id`, the expected SAS, an ECIES blob for SSID `Café Ж"\` / password `p@ss word 12345` with fixed eph key + nonce, and a wrong-AAD blob. Output: `sim/vectors.h` (C arrays) and the web JSON fixture. Commit both generated files; the script's header says they are generated.
- [ ] **Step 2: Failing host test** `test_store.c::test_pair_roundtrip_and_corrupt`. Run → FAIL. Implement codec + NVS adapter. PASS.
- [ ] **Step 3: Implement `identity.c`** with the PSA calls from Global Constraints. Self-test under `CONFIG_AELYS_IDENTITY_SELFTEST`: import the vector private key, check SAS == vector, decrypt blob == vector plaintext, wrong-AAD blob → error, sign a message and print the signature base64url once (`selftest sig=`), then print `identity selftest PASS|FAIL`.
- [ ] **Step 4: Board (slot 1)** — scratch build with the self-test on (defaults file outside the repo), flash, `python3 tools/serlog.py --seconds 10 --reset` → `identity selftest PASS`; paste the `sig=` value into `tools/companion_vectors.py --verify-sig <b64>` (calls backend `verify_signature`) → `OK`. Then build without the self-test.
- [ ] **Step 5:** `idf.py size` ≤ 2 MB; ctest PASS.
- [ ] **Step 6: Commit** `build(firmware): allocate mbedTLS buffers in PSRAM` · `feat(firmware): add device identity key, SAS and Wi-Fi decryption`.

### Task F6: USB pairing RPCs and pair screen — model: **sonnet** · board: **slot 2** · pre-plan-2: yes

**Files:**
- Modify: `components/logic/include/improv.h`, `improv.c`, `sim/test_improv.c`, `components/net/net_improv.c`, `components/net/CMakeLists.txt` (`PRIV_REQUIRES identity`), `components/logic/include/ui_events.h`, `components/logic/include/screen_fsm.h`, `screen_fsm.c`, `sim/test_screen_fsm.c`, `components/ui/screens.c`, `main/app_main.c`
- Create: `components/ui/scr_pair.c`, `tools/improv_pair.py`

**Interfaces — Produces:**
- Vendor RPCs (Improv `type 0x03`, data `[cmd][len][strings as len+bytes]`); replies are `RESULT` frames with the same `cmd`:
  | cmd | Name | Args | Result strings | Errors |
  |---|---|---|---|---|
  | `0xA0` | PAIR_BEGIN | secret (32–128), api_url | `[public_key_b64url]` | `0x80` lost mode on; `0x01` bad args |
  | `0xA1` | PAIR_CODE | pairing_id (≤ 39) | `[]` (code is only on screen) | `0x81` no pending pairing |
  | `0xA2` | PAIR_COMMIT | device_id (≤ 39) | `[]` | `0x81` |
  | `0xA3` | PAIR_STATUS | — | `["paired", device_id]` or `["unpaired"]` | — |
  `#define IMPROV_RPC_PAIR_BEGIN 0xA0` … `IMPROV_ERR_LOST_MODE 0x80`, `IMPROV_ERR_NOT_PENDING 0x81`; `int improv_rpc_strings(const improv_frame_t *f, char out[][129], int max);` returns the count or -1 on inconsistent lengths.
- Pending pairing lives in RAM only and expires 180 s after PAIR_BEGIN or on PAIR_COMMIT; the secret is wiped right after PAIR_CODE computes the SAS.
- `ui_events.h` (append, keep existing values): `UI_EV_TAP, UI_EV_SWIPE_LEFT, UI_EV_SWIPE_RIGHT, UI_EV_SNAPSHOT, UI_EV_LINK, UI_EV_PAIR, UI_EV_ACTION, UI_EV_FIND, UI_EV_WIFI_ADD`. Payloads: `UI_EV_TAP` = x, y (uint16 LE, as `UI_EV_TOUCH`); `UI_EV_SNAPSHOT` `[0]` = 1 live / 0 cached (data itself in `ui_snap_tb`); `UI_EV_LINK` `[0]` = `ui_link_state_t {LINK_UI_UNPAIRED, LINK_UI_CONNECTING, LINK_UI_ONLINE, LINK_UI_OFFLINE}`; `UI_EV_PAIR` `[0]` = `PAIR_UI_HIDE|PAIR_UI_CODE|PAIR_UI_DONE`, `[1..6]` ASCII digits for CODE; `UI_EV_ACTION` `[0]` = `act_kind_t`, `[1]` = ok, `[2..25]` = error code (NUL-terminated, `"OFFLINE"` when not sent); `UI_EV_FIND` `[0]` = 1 start / 0 stop; `UI_EV_WIFI_ADD` `[0]` = 0 connecting / 1 connected / 2 failed, `[1..33]` = SSID, `[34..59]` = previous SSID cut to 25 bytes (UTF-8 safe); `UI_EV_BTN` `[0]` = `BTN_TOP|BTN_LOW`.
- `screen_fsm`: add `SCR_TODAY, SCR_FOCUS, SCR_INBOX, SCR_PAIR` (appended). Rules added here: PAIR_UI_CODE → `SCR_PAIR` (not from lost mode); PAIR_UI_DONE/HIDE → `SCR_HOME`.
- `scr_pair.c` = design "Сопряжение · код" (6 digits, "Confirm this code in Aelys web") and "Paired / Syncing your day" (2 s, then home); first boot unpaired + unprovisioned shows "Hi, I'm Aelys / Connect me by USB and open Aelys web" (design "Первое включение") on the home screen's status line area.

- [ ] **Step 1: Failing tests:** `test_improv.c::test_rpc_strings` (2 strings; length overflow → -1); `test_screen_fsm.c::test_pair_code_shows_pair_screen`, `test_pair_done_returns_home`, `test_pair_code_ignored_in_lost_mode`; `test_screens.c::test_pair_screen_shot` (renders 6 digits inside radius 233).
- [ ] **Step 2–3:** FAIL → implement logic + UI. In `net_improv.c`: PAIR_BEGIN in lost mode → error `0x80` (`test_pair_begin_refused_in_lost_mode` is the board step below — lost state is in main; pass a `bool (*lost_on)(void)` into `net_start` via `net_store_t`).
- [ ] **Step 4: `tools/improv_pair.py`** — `--secret-gen`, sends PAIR_BEGIN with `https://example.invalid/api/v1`, prints the public key, sends PAIR_CODE with a fixed UUID, prints the SAS it computes itself with `sas_code` (for the owner to compare on screen), PAIR_STATUS; `--commit <device_id>`; never prints the secret.
- [ ] **Step 5: Board (slot 2)** — flash; run the tool; the owner confirms the 6 digits on the board equal the tool's; PAIR_STATUS `unpaired` before commit; `--commit 11111111-1111-4111-8111-111111111111` → "Paired" screen → PAIR_STATUS `paired`; reboot → still `paired`. With lost mode forced on (temporary debug build, as in plan 1 Task 7) → PAIR_BEGIN answers error `0x80` (`test_pair_begin_refused_in_lost_mode`). Re-flash the clean build. The fake pairing stays on the board until F7, where the real pairing replaces it (PAIR_COMMIT overwrites the record).
- [ ] **Step 6: Commit** `feat(firmware): pair over USB with Improv vendor RPCs`.

### Task W1: Improv over Web Serial — model: **sonnet** · board: no · pre-plan-2: yes

**Files:** Create `apps/web/src/lib/companion/{improv.ts,serial.ts,webserial.d.ts}`, `apps/web/src/tests/companion-improv.test.ts`.

**Interfaces — Produces:**
```ts
export function improvFrame(type: number, data: Uint8Array): Uint8Array           // same layout/checksum as firmware improv_build
export class ImprovParser { push(bytes: Uint8Array): ImprovPacket[] }              // skips log text between frames, resets on bad checksum
export type ImprovPacket = { type: number; data: Uint8Array }
export function rpc(cmd: number, strings: string[]): Uint8Array                    // [cmd][len][len+utf8...]
export function resultStrings(p: ImprovPacket): { cmd: number; strings: string[] }
export class CompanionSerial {
  static supported(): boolean                                                       // !!navigator.serial and not a native host
  static async request(): Promise<CompanionSerial>                                  // navigator.serial.requestPort() (no filters: USB-Serial/JTAG), open 115200
  info(): Promise<{ firmware: string; version: string }>                            // RPC 0x03; must start with "aelys-companion" else throws CompanionError('NOT_AELYS')
  state(): Promise<'authorized' | 'provisioning' | 'provisioned'>
  pairBegin(secret: string, apiUrl: string): Promise<string>                         // → public key b64url
  pairCode(pairingId: string): Promise<void>
  pairCommit(deviceId: string): Promise<void>
  pairStatus(): Promise<{ paired: boolean; deviceId?: string }>
  sendWifi(ssid: string, password: string): Promise<'ok' | 'bad_password'>         // RPC 0x01, waits ≤ 20 s for STATE provisioned / ERROR 0x03
  close(): Promise<void>
}
export class CompanionError extends Error { code: 'NOT_AELYS' | 'LOST_MODE' | 'NOT_PENDING' | 'TIMEOUT' | 'BAD_ARGS' | 'UNSUPPORTED_BROWSER' }
```
One request at a time (a promise queue); each waits ≤ 5 s (Wi-Fi 20 s) for its RESULT/ERROR.

- [ ] **Step 1: Failing tests:** `frame bytes match firmware test vector` (copy the exact bytes from `sim/test_improv.c::test_build_then_parse_roundtrip`); `parser skips log lines and split chunks`; `bad checksum resets`; `pairBegin over a fake port resolves the key` (fake `SerialPort` with readable/writable streams scripted to answer); `error 0x80 maps to LOST_MODE`; `timeout maps to TIMEOUT`; `supported() false without navigator.serial`.
- [ ] **Step 2–4:** FAIL → implement → PASS; `typecheck` PASS.
- [ ] **Step 5: Commit** `feat(web): talk Improv to the companion over Web Serial`.

### Task W2: Companion API, ECIES and web re-auth — model: **sonnet** · board: no · pre-plan-2: yes (mocks)

**Files:** Create `apps/web/src/lib/companion/{ecies.ts,api.ts,types.ts}`, `apps/web/src/tests/companion-api.test.ts`. Modify `apps/web/src/lib/api.ts` (export `signWithThisDevice`).

**Interfaces — Produces:**
```ts
export async function encryptWifi(devicePubB64: string, deviceId: string, ssid: string, password: string,
  testOnly?: { ephemeralJwk: JsonWebKey; nonce: Uint8Array }): Promise<string>          // blob b64url, scheme from Task F5
export function newPairingSecret(): string                                               // 32 random bytes b64url (43 chars)
export async function sha256Hex(s: string): Promise<string>
// api.ts — all via getSharedApiClient().request(path, { method, body, queueOnOffline: false })
export const companion = {
  requestPairing(secretHash: string, publicKey: string): Promise<{ pairing_id: string }>, // POST /api/v1/pairing/request {platform:'companion', display_name:'Aelys'}
  approve(pairingId: string, secret: string, sas: string): Promise<{ device_id: string }>,
  list(): Promise<CompanionDevice[]>,                       // GET /api/v1/companion/devices (Task B1; /api/v1/devices is blocked for the native generic transport)
  state(id: string): Promise<CompanionState>,               // GET /api/v1/companion/devices/{id}
  setLost(id: string, body: LostBody): Promise<void>,       // PUT .../lost-mode (reauth added by caller when on=false)
  setIce(id: string, body: IceBody): Promise<void>,
  find(id: string): Promise<{ command_id: string }>,
  addWifi(id: string, blob: string): Promise<{ command_id: string }>,
  scanWifi(id: string): Promise<{ command_id: string }>,
  removeWifi, orderWifi, setSettings, restart, unpair       // B1 routes, same pattern
}
export async function reauth(purpose: 'lost_off' | 'unpair', targetId: string): Promise<{ challenge_id: string; signature: string }>
// web: deviceRequest('auth/device/challenge', {device_id: own}) then signWithDeviceKey over
// `aelys-companion-lost-off-v1\n{target}\n{nonce}` or `aelys-companion-unpair-v1\n{target}\n{nonce}`;
// native host: (await loadNativeTransport()).deviceReauth(origin, purpose, targetId) (Task W3)
```
`types.ts` mirrors plan 2 Task 8 + Task B1 response shapes exactly (field names snake_case as the API returns them).

- [ ] **Step 1: Failing tests:** `encryptWifi matches the Python vector` (load `fixtures/companion-vectors.json`, pass its eph JWK + nonce → identical blob); `encryptWifi rejects ssid > 32 bytes or password > 64 bytes`; `secret is 43 url-safe chars`; `sha256Hex("abc")` known value; `reauth signs the exact context string` (in-memory identity store via `setIdentityStore`, verify with WebCrypto); `setLost does not queue offline` (client mock asserts `queueOnOffline: false`).
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(web): add the companion API client and Wi-Fi encryption`.

### Task W3: Native re-auth operation — model: **sonnet** · board: no · pre-plan-2: yes

**Files:** Modify `packages/native-transport/src/transport.rs` (new `#[tauri::command] pub async fn native_device_reauth`), `apps/desktop/src-tauri/src/lib.rs` and `apps/mobile/src-tauri/src/lib.rs` (register it), `apps/desktop/src-tauri/capabilities/*` only if commands need listing there (check how `native_biometric_set` is allowed), `apps/web/src/lib/nativeTransport.ts` (`deviceReauth(origin, purpose, targetId)`), `apps/web/src/tests/native-transport.test.ts`.

**Interfaces — Produces:** `native_device_reauth(origin: String, purpose: String, target_device_id: String) -> Result<{challenge_id, signature}, String>`: `purpose` ∈ `lost_off|unpair` (else `"INVALID_REQUEST"`); validates `target_device_id` with `valid_id`; always runs `crate::biometric::authenticate()` when `crate::biometric::available()` (fingerprint/Touch ID, as the design says), otherwise proceeds; then challenge for the **own** device exactly as the login path does (`transport.rs` ~:2076) and `key.sign("aelys-companion-{lost-off|unpair}-v1\n{target}\n{nonce}")`.

- [ ] **Step 1: Failing Rust test** next to the existing transport tests: mock server answers the challenge; assert the signed message string and that an unknown purpose is rejected; TS test: `deviceReauth` invokes `native_device_reauth` with those args.
- [ ] **Step 2–4:** FAIL → implement → PASS (`cargo test --manifest-path packages/native-transport/Cargo.toml`, web tests).
- [ ] **Step 5: Commit** `feat(native): sign companion re-auth challenges after biometrics`.

### Task W4: "Add companion" page — model: **sonnet** · board: no (owner check happens in F7) · pre-plan-2: yes (mocks)

**Files:** Create `apps/web/src/views/settings/devices/{DevicesPanel.tsx,AddCompanion.tsx,devices.css}`, `apps/web/src/tests/companion-add.test.tsx`. Modify `views/settings/useSettings.ts` (`PanelId` += `'devices'`; item `{ id: 'devices', title: 'Devices', desc: 'Companions paired with Aelys', icon: <design's icon>, tone: <design's tile tone> }` in **System** between Connection and Security, as in design frame 1), `SettingsView.desktop.tsx`, `SettingsView.mobile.tsx` (`panel === 'devices'`).

**Behaviour (design frame 6, three numbered steps, copy verbatim):**
1. "Connect Aelys by USB-C" / "Use a data cable. Chrome or the Aelys app for Mac" → button opens the port; `info()` must say `aelys-companion`; shows "Aelys found on USB". Native host or no Web Serial → the step shows the design's mobile hint text ("To add a companion, connect it by USB to Aelys on your Mac or on the web.") and nothing else — the Mac app has no Web Serial in v1.
2. On connect, silently: `secret = newPairingSecret()`, `pub = pairBegin(secret, absoluteApiBase)`, `requestPairing(sha256Hex(secret), pub)`, `pairCode(pairing_id)`. Then "Enter the code shown on Aelys" / "Make sure it matches the 6 digits on the round screen" with six digit boxes and "Pair" → `approve(...)` → `pairCommit(device_id)`. `SAS_MISMATCH` → "The code doesn't match. Check the digits on Aelys and try again." and restart from step 2 (new secret); `LOST_MODE` → "Aelys is in lost mode. Turn lost mode off before pairing it again." `PAIRING_EXPIRED`/`TIMEOUT` → restart step 2.
3. "Choose Wi-Fi" / "Aelys copies a saved network from this computer, or you add one" → if `state()` is `provisioned`, show "Aelys is already online" and finish; else Network name + Password fields → `sendWifi`; `bad_password` → "Wrong password for {ssid}" (design wording from frame 4). Footer: "Pairing works only over USB, so nobody can pair Aelys from afar."
`absoluteApiBase = new URL(getApiConfig().baseUrl, location.origin).href` and must be `https:` (else step 1 shows "Aelys needs a secure (https) backend"). The secret is held only in component state and dropped on unmount.

- [ ] **Step 1: Failing tests** (mock `CompanionSerial` and `companion`): `happy path calls pairBegin → requestPairing → pairCode → approve → pairCommit in order with the same secret`; `sas mismatch restarts with a new secret`; `lost mode error shows the message`; `no Web Serial shows the hint`; `http backend is refused`; `devices nav item sits between Connection and Security`.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck. Visual check against frame 6 in `pnpm dev` (desktop and 390 px wide); attach screenshots.
- [ ] **Step 5: Commit** `feat(web): add the companion pairing page`.

### Task B1: Backend protocol v1.1 (additive) — model: **sonnet** · board: no · pre-plan-2: **no** (edits plan 2's code; merge `main` first)

**Files:** Modify `backend/app/companion/{snapshot.py,commands.py,channel.py,api.py,models.py,access.py}`, `docs/companion-protocol.md` (version line → `v1.1 (additive)`, new rows), `docs/openapi.json` (`make openapi`). Create `backend/alembic/versions/0051_companion_v11.py` (`down_revision = "0050_companion"`, inspector-guarded), `backend/tests/test_companion_v11.py`.

**Interfaces — Produces (all additive; v1 boards keep working):**
- `CompanionSnapshot` += `today_done: int`, `today_total: int` (open+completed tasks due today in the owner's day as `build_agenda` defines it), `other_unread_count: int` (unread of kinds outside the allowed prefixes).
- `hello` += optional `contacts {phone ≤ 23, telegram ≤ 32}` → `companion_state.contacts_json` (never logged).
- `metrics` += optional `battery_pct 0..100`, `charging bool`, `heap_at_connect_min int`.
- board → server `wifi_state {saved: [str ≤ 32] ≤ 5, current: str | null}` → `companion_state.wifi_json`.
- `command_ack` for **any** command id the server sent in the last 24 h (including non-queued `wifi_add`, `restart`) is recorded; `companion_state.command_log_json` keeps the last 10 `{id, name, sent_at, ok: bool|null, error_code}` (`ok=null` until acked; `wifi_scan_result` sets `ok=true`).
- `lost_mode` args += `show_email: bool = false`, `email: str ≤ 48 | null`, `qr: "telegram"|"phone"|"none" = "telegram"`, `since: datetime` (server-set). `ice_update` args → `{owner_name ≤ 32, contacts: [{name ≤ 32, relation ≤ 16 = "", phone ≤ 23}] ≤ 2, med_note ≤ 96, show_name, show_contacts = true, show_med = true}`.
- New commands: `settings {brightness 5..100}` (queued, dedupe by name), `wifi_remove {ssid}`, `wifi_order {ssids ≤ 5}`, `restart {}`, `unpair {}` (not queued → 409 `DEVICE_OFFLINE`, except unpair, see route).
- Routes (owner devices only, same guard as plan 2 Task 8; each command route returns `{command_id}`): `GET /api/v1/companion/devices` → the owner's live companions as `[{device_id, display_name, online, last_seen_at, wifi_current, battery_pct}]`; `PUT /api/v1/companion/devices/{id}/settings {brightness}`; `POST .../wifi/remove {ssid}`; `PUT .../wifi/order {ssids}`; `POST .../restart`; `POST .../unpair {reauth: {challenge_id, signature}}` — verifies `aelys-companion-unpair-v1\n{target}\n{nonce}` like the lost-off reauth, sends `unpair` if online, then revokes the device with the same code path as `/devices/{device_id}/revoke` (socket closes 4403); `POST .../wifi` and `.../wifi-scan` and `.../find` now return `{command_id}`.
- `GET /api/v1/companion/devices/{id}` += `contacts`, `wifi {saved, current}`, `battery {pct, charging} | null`, `settings {brightness}`, `command_log`, `lost_mode.since`.

- [ ] **Step 1: Failing tests:** `test_list_companions_owner_only`; `test_snapshot_today_counts_and_other_unread`; `test_hello_contacts_stored_not_logged` (caplog); `test_wifi_state_exposed_in_device_state`; `test_late_ack_recorded` (send `wifi_add`, close socket, reconnect, board acks `WIFI_FAILED` → `command_log` has it); `test_settings_queued_while_offline_and_deduped`; `test_restart_offline_is_409`; `test_unpair_requires_reauth_sends_command_and_revokes` (online board gets `command unpair` then close 4403); `test_v1_ice_args_still_accepted`.
- [ ] **Step 2–4:** FAIL → implement → PASS; full suite, ruff, mypy, bandit, `alembic upgrade head && alembic check`, `make openapi`.
- [ ] **Step 5: Commit** `feat(companion): extend the device protocol to v1.1` · `docs(companion): document protocol v1.1`.

### Task F7: Link — sign-in and channel — model: **sonnet** · board: **slot 3** · pre-plan-2: **no** (plan 2 merged and deployed to Railway)

**Files:**
- Create: `components/link/{CMakeLists.txt,include/link.h,link.c,link_http.c,link_ws.c,link_cmd.c}`
- Modify: `main/idf_component.yml` (`espressif/esp_websocket_client` pinned), `main/app_main.c`, `main/metrics.c` (`heap_at_connect_min`, battery), `main/Kconfig.projbuild` (`AELYS_LINK_CHAOS_S` int, default 0 — dev-only forced reconnect period), `components/board/board_power.c` + `board.h` (`bool board_battery(uint8_t *pct, bool *charging)` from the AXP2101 fuel gauge)

**Interfaces — Consumes:** F2 `proto_*`, F4 `link_next`, F5 `identity_*`, F3 `ui_snap_tb`. **Produces (`link.h`):**
```c
typedef struct {
    void (*on_command)(const proto_msg_t *m);            /* link_cmd.c handlers; acks via link_send_ack */
    void (*save_snap)(const snap_t *s); bool (*load_snap)(snap_t *s);
    const char *(*contact_phone)(void); const char *(*contact_telegram)(void);
} link_deps_t;
esp_err_t link_start(const link_deps_t *d);              /* `link` task, core 0, prio 5, stack 6 KB internal; buffers (4 KB rx, 1 KB tx, token 1 KB, proto_msg_t) in PSRAM */
void link_notify_paired(void);                           /* from net_improv after PAIR_COMMIT */
bool link_post_action(act_kind_t k, const char *target_id);  /* from the ui task; false = offline (UI shows "No connection") */
bool link_send_ack(const char *cmd_id, bool ok, const char *error_code);
bool link_send_raw(const char *json, size_t n);          /* wifi_scan_result / wifi_state built by proto_* */
```
Behaviour:
- HTTP (`esp_http_client`, crt bundle, 10 s timeout): `POST {api_url}/auth/device/challenge {"device_id"}`; 401 with `detail.code == "UNAUTHORIZED"` → `LE_CHALLENGE_UNKNOWN`; any other non-200 → `LE_CHALLENGE_FAIL`. `POST {api_url}/auth/device/login {"challenge_id","signature"}` → `access_token` (RAM only; refresh token, if any, ignored and zeroed).
- WS: `wss://` + host + `/api/v1/devices/channel`, header `Authorization: Bearer <token>`, auto-reconnect off (the FSM drives it), fragments reassembled into the 4 KB buffer (bigger → drop + log code only), close code read from the close frame.
- On `ready`: check `device_id` == ours (else close, `LE_LOGIN_FAIL`); send `hello` (with contacts) then `wifi_state`. Against a v1 server (before B1) `wifi_state` draws `error UNKNOWN_MESSAGE`: the board ignores `error` messages except to log their `code`; if plan 2's `hello` model rejects the extra `contacts` key, send contacts only once B1 is deployed (report which). `snapshot` → `tribuf_back(&ui_snap_tb)` ← parsed snap, publish, post `UI_EV_SNAPSHOT` (data[0]=1); `save_snap` at most every 300 s. `heartbeat` every 30 s; no frame for 75 s → close → backoff. `metrics` every 300 s (spec §4.6). Actions: uuid4 id, in-flight table of 4 with 10 s timeout, resent with the **same id** after a reconnect, result → `UI_EV_ACTION`. `UI_EV_LINK` on every state change (`LINK_UI_UNPAIRED|CONNECTING|ONLINE|OFFLINE`).
- Heap rule before every TLS connect: wait (≤ 10 s, 500 ms steps) until `heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL) ≥ 16384`; log one WARN line `link connect heap_int=%u largest=%u` per attempt; track the minimum for metrics.
- `LA_WIPE_PAIRING` → `identity_wipe()`, `UI_EV_LINK(UNPAIRED)`; Wi-Fi, lost mode and ICE stay.

- [ ] **Step 1: Host-side guard** — `test_link_fsm` already covers the decision table; add `test_proto.c::test_hello_with_contacts` (contacts escaped, present only when non-empty).
- [ ] **Step 2: Implement.** `idf.py build`; `idf.py size` ≤ 2 MB.
- [ ] **Step 3: Board (slot 3) — real pairing with the owner:** owner opens the W4 page (deployed web, or `pnpm dev` signed in as the owner) in Chrome, plugs the board in, types the code from the board, Wi-Fi step skipped if online. Expected on serial (`serlog.py --seconds 60`): `link connect heap_int=…`, no errors; within 10 s the backend shows the board online (`GET /api/v1/companion/devices/{id}` → `online: true`, `fw_version`). Log never shows the token, secret or code (grep the capture for the code digits and `Bearer`).
- [ ] **Step 4: Re-auth paths on the board:** (a) owner restarts the backend service → board reconnects with backoff, pairing kept; (b) Wi-Fi off/on at the router → same; (c) owner revokes the device in the app → socket 4403 → challenge 401 → `UI_EV_LINK(UNPAIRED)`, `PAIR_STATUS` = unpaired; re-pair via W4.
- [ ] **Step 5: Heap at reconnect** — scratch build with `CONFIG_AELYS_LINK_CHAOS_S=60` and metrics period 10 s (defaults outside the repo), 30 min: record min `heap_int`, cumulative `heap_int_min`, min `largest`, `heap_at_connect_min`, TLS failures (expect 0). Update `firmware/companion/docs/budgets.md` (new row "Free internal heap at reconnect") — FAIL is reported, not tuned away.
- [ ] **Step 6: Commit** `feat(firmware): sign in by device key and keep the companion channel` · `perf(firmware): record heap at reconnect`.

### Task F8: Home screens, actions, offline cache — model: **sonnet** · board: **slot 4** · pre-plan-2: sim part yes, board check no

**Files:**
- Create: `components/logic/include/gesture.h`, `gesture.c`, `sim/test_gesture.c`, `components/ui/{scr_today.c,scr_focus.c,scr_inbox.c,scr_toast.c,mood_rules.c}`, `sim/test_mood_rules.c`
- Modify: `components/board/board_input.c` (feed `gesture_feed` every poll; post `UI_EV_TAP`/`UI_EV_SWIPE_*`; post `UI_EV_BTN` on a short press of one key when the combo never started — find on the board which physical key is top and record it in a comment), `components/logic/screen_fsm.c`, `sim/test_screen_fsm.c`, `components/ui/{screens.c,scr_home.c,include/ui.h,include/ui_screens_priv.h}`, `sim/test_screens.c`, `components/logic/store_codec.{h,c}` (snap blob), `main/store_nvs.{c,h}` (`snap`), `main/app_main.c` (load cache → publish with data[0]=0; wire `ui_set_action_sink(link_post_action)`)

**Interfaces — Produces:**
```c
/* gesture.h */
typedef enum { GEST_NONE, GEST_TAP, GEST_SWIPE_LEFT, GEST_SWIPE_RIGHT } gesture_t;
typedef struct { bool down; int16_t x0, y0, x, y; uint32_t t0; } gesture_ctx_t;
gesture_t gesture_feed(gesture_ctx_t *g, bool touched, int16_t x, int16_t y, uint32_t now_ms);
/* tap: released within 400 ms and moved < 20 px; swipe: |dx| ≥ 60 px, |dx| ≥ 2|dy|, within 600 ms; else none */
/* ui.h */
void ui_set_action_sink(bool (*sink)(act_kind_t k, const char *target_id)); /* main passes link_post_action */
/* ui_screens_priv.h */
mood_t ui_mood_for(const snap_t *s, int64_t now, bool online, bool just_completed);
```
Screen rules (`screen_fsm`): `SWIPE_RIGHT` on HOME → TODAY, `SWIPE_LEFT` on HOME → FOCUS, the reverse swipes go back; INBOX ← TAP on the Today unread row; INBOX → TODAY on `BTN_LOW`, tap outside rows or 15 s; `BTN_LOW` on TODAY/FOCUS → HOME; lost mode: every new event is ignored (`test_swipes_ignored_in_lost_mode`).
Screens (design frames, black background, module colours from the design tokens): **Today** — date, clock, next task row (circle; tap → `task.complete`), next event row (time), "{n} new" row (tap → Inbox), "{done} / {total} done" with the day-progress ring (hidden when `today_total == -1`). **Aelys** (existing home) — clock, "{left} left today", orbit `orbit_set(done, total)`, face mood from `ui_mood_for`; offline → design "Нет связи": "Offline", "Showing data from HH:MM" (snapshot `generated`, local time), tasks line; unpaired → first-boot text. **Focus** — none: "Focus · 25 min session" + hint "Start" (tap or `BTN_TOP` → `focus.start` pomodoro); active: remaining of 25 min (`elapsed_s` + seconds since the snapshot arrived), melting coral ring, hint "Pause"; paused: "Paused", time blinking, hint "Resume", line "Hold to stop" (hold ≥ 800 ms → `focus.stop`); remaining 0 → "Session done" + hint "Done" (→ `focus.stop`). Mode `stopwatch` counts up without a ring. **Inbox** — up to 5 notice rows (title + "Tasks|Calendar|Focus · {relative time}"), tap → `notification.read`; footer "+{other_unread} from other apps" (v1 server: hidden). Action feedback: optimistic tick on the row; `UI_EV_ACTION` failure → toast "Didn't work — try again" for 2 s; offline → toast "No connection".
`ui_mood_for`: offline → OFFLINE; focus active → FOCUSED; overdue > 0 → SAD; next task due < 60 min → WORRIED; `just_completed` → HAPPY (3 s); `today_total > 0 && today_done == today_total` → PROUD; else CALM.

- [ ] **Step 1: Failing tests:** `test_gesture.c` (`test_tap`, `test_slow_drag_is_none`, `test_swipe_left_right`, `test_vertical_drag_is_none`); `test_screen_fsm.c` (`test_swipe_cycle_today_home_focus`, `test_inbox_back`, `test_swipes_ignored_in_lost_mode`); `test_mood_rules.c` (each rule, priority order offline > focused > sad > worried > happy > proud > calm); `test_screens.c` (`test_today_shot`, `test_focus_shots` none/active/paused/done, `test_inbox_shot`, `test_offline_shot`, all pixels within radius 233, long Cyrillic titles ellipsised); `test_store.c::test_snap_roundtrip`; `test_tap_sends_task_complete` (sink captures `ACT_TASK_COMPLETE` with the task id).
- [ ] **Step 2–4:** FAIL → implement → PASS. Attach sim shots of Today, Aelys (online/offline), Focus ×4, Inbox.
- [ ] **Step 5: Board (slot 4)** — swipe Today ← Aelys → Focus; owner creates a task due in 30 min in the app → Today shows it within 5 s, face WORRIED; tap its circle → completed in the app; start/pause/resume/stop focus from the board and see it in the app; mark a notice read; pull Wi-Fi → "Offline · Showing data from …"; reboot offline → cached data shows. Touch → screen latency on a swipe (plan 1 method) ≤ 50 ms; idle fps unchanged. Record in `budgets.md`.
- [ ] **Step 6: Commit** `feat(firmware): add swipe gestures and buttons` · `feat(firmware): show the live snapshot on Today, Aelys and Focus` · `feat(firmware): cache the last snapshot for offline use`.

### Task F9a: Lost mode, ICE, settings, restart, unpair commands — model: **sonnet** · board: **slot 5** · pre-plan-2: logic yes, board no

**Files:** Modify `components/link/link_cmd.c`, `main/app_main.c` (deps), `main/store_nvs.{c,h}` (`settings` blob: `{uint8_t brightness}`), `components/logic/store_codec.{h,c}`, `components/board/board_display.c` + `board.h` (`esp_err_t board_display_set_brightness(uint8_t pct)`: CO5300 cmd `0x51`, 5..100 % mapped to 13..255), `components/ui/scr_toast.c` ("Only the owner can turn this off" hint from design "Режим потери · нажата кнопка"), `sim/test_owner.c`.

**Behaviour:** `lost_mode` → `owner_apply_lost` → `store_save_lost` → write shown owner to `ui_owner_tb` → `UI_EV_OWNER` + `UI_EV_LOST` → ack. `ice_update` → `owner_apply_ice` → save owner (and lost if on) → publish → ack. `settings` → save + apply brightness → ack (also applied at boot). `restart` → ack, wait for the send, `esp_restart()` after 500 ms. `unpair` → ack, then wipe identity, Wi-Fi list, lost, owner overrides (back to `owner_defaults`), settings and `snap`, then restart into the first-boot screen. Unknown command → ack `UNSUPPORTED`; bad args → `BAD_ARGS`. Any button/tap on the lost screen shows the hint toast for 2 s.

- [ ] **Step 1: Failing tests:** `test_owner.c::test_lost_command_roundtrip_through_store` (apply → encode → decode → equal); `test_proto.c::test_unknown_command_parses_as_unknown` (exists from F2 — reuse); `test_screens.c::test_lost_hint_toast_shot`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Board (slot 5)** — from the app (W5/W6 if done, else `curl` with an owner token): lost on (message in Cyrillic) → board shows the lost screen within 2 s; both buttons 2 s → ICE card with the ICE contacts; reboot → still lost; lost on while the board is off Wi-Fi → delivered on reconnect; lost off (with re-auth) → home. ICE update visible; brightness 20 % / 100 % visible; restart works; unpair → board on first-boot screen and the device gone from the app.
- [ ] **Step 6: Commit** `feat(firmware): obey lost mode, ICE and device commands`.

### Task F9b: Wi-Fi commands — model: **sonnet** · board: **slot 6** · pre-plan-2: logic yes, board no

**Files:** Modify `components/logic/include/store_codec.h`, `store_codec.c`, `sim/test_store.c`, `components/net/{include/net.h,net_wifi.c}`, `components/link/link_cmd.c`, `components/ui/scr_toast.c`.

**Interfaces — Produces:** `bool wifi_list_remove(wifi_list_t *l, const char *ssid);` `bool wifi_list_reorder(wifi_list_t *l, const char ssids[][33], int n);` (listed SSIDs first in that order, unknown names ignored, the rest keep their order); `net.h`: `int net_wifi_scan(wifi_seen_t *out, int max);` (blocking ≤ 4 s, dedupe by SSID keeping the strongest, sorted by RSSI, max 10), `const char *net_wifi_current_ssid(void);`, `bool net_wifi_try(const char *ssid, const char *pass);` (= the existing provision path; on failure the saved list reconnects as today).

**Behaviour:** `wifi_add` → b64url decode → `identity_wifi_decrypt` (fail → ack `DECRYPT_FAILED`) → `UI_EV_WIFI_ADD(connecting, ssid)` (design "Wi-Fi с телефона": "New Wi-Fi from phone · {ssid} · Connecting…") → `net_wifi_try` → success: saved, toast "Connected"; failure: toast "Wrong password · {ssid} · still on {previous} · Fix it in Aelys on your phone" (design "Wi-Fi · неверный пароль"). The ack is queued in RAM and sent after the channel is back (`WIFI_FAILED` or ok), followed by `wifi_state`. Password and plaintext buffers zeroed right after use. `wifi_scan` → `wifi_scan_result` with the command id. `wifi_remove`/`wifi_order` → list op → save → ack → `wifi_state`.

- [ ] **Step 1: Failing tests:** `test_store.c::test_wifi_remove`, `test_wifi_reorder_partial_and_unknown`; `test_screens.c::test_wifi_toast_shots` (connecting / connected / wrong password with a 32-char SSID).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Board (slot 6)** — owner (types passwords themselves in the app — W6, or `curl` with a blob from `tools/companion_vectors.py --encrypt` run by the owner): add a second real network → connects, ack ok, `wifi_state` lists both; add with a wrong password → toast, board back on the first network within 30 s, app/`command_log` shows `WIFI_FAILED`; scan returns nearby networks; remove and reorder reflected in `wifi_state`; serial capture contains no password (grep).
- [ ] **Step 6: Commit** `feat(firmware): add Wi-Fi networks sent from the phone`.

### Task F9c: Find — sound through the ES8311 — model: **sonnet** · board: **slot 7** · pre-plan-2: bring-up yes, command no

**Files:** Create `components/board/board_audio.c`. Modify `components/board/{board.h,board_pins.h,CMakeLists.txt}` (`espressif/es8311` pinned in `main/idf_component.yml`, `esp_driver_i2s`), `components/link/link_cmd.c`, `components/ui/scr_toast.c` (design "Найти Элис": "Here I am!", "Playing sound · tap to stop", flashing ring).

**Interfaces — Produces:** `esp_err_t board_audio_beep(uint32_t duration_ms);` (non-blocking; own task prio 3, created on demand and deleted when done; codec + I2S + PA enabled only while playing, so no steady RAM cost) and `void board_audio_stop(void);`. Pattern: 2 kHz sine from a 32-entry table, 200 ms on / 200 ms off, 60 s (design: "beeps and flashes for 1 minute"). Pins (I2S MCLK/BCLK/WS/DOUT, PA enable, ES8311 I2C address) from BSP `waveshare/esp32_s3_touch_amoled_1_75c` 3.0.0, same method as plan 1 Task 3 (comment names the source).

**Behaviour:** `play_sound` → ack → `UI_EV_FIND(1)` + `board_audio_beep(60000)`; any tap or button → stop (`UI_EV_FIND(0)`); works on any screen, also in lost mode and with the screen asleep.

- [ ] **Step 1: Failing test:** `test_screens.c::test_find_overlay_shot` and `test_screen_fsm.c::test_find_overlay_does_not_leave_lost`.
- [ ] **Step 2–3:** FAIL → implement → PASS.
- [ ] **Step 4: Board (slot 7)** — "Find" in the app (or `curl`) → audible beeps + flashing ring; tap stops it; 60 s cap; `heap_int` back to its previous value after playback (metrics line before/after).
- [ ] **Step 5: Commit** `feat(firmware): play a find sound on the ES8311 speaker`.

### Task W5: Devices list, Aelys overview, lost mode — model: **sonnet** · board: no · pre-plan-2: yes (mocks of B1 shapes)

**Files:** Create `views/settings/devices/{CompanionOverview.tsx,LostModePage.tsx,ReauthSheet.tsx,RoundPreview.tsx}`, `tests/companion-pages.test.tsx`. Modify `DevicesPanel.tsx`, `devices.css`.

**Behaviour (design frames 1–2, copy verbatim):** Devices list rows "Aelys" / "{Online|Offline} · {wifi.current} · {battery}%" (missing parts dropped) + the "To add a companion…" hint; on web the "Add companion" flow from W4 is reachable from this panel. Sub-pages live in the URL (`?section=devices&device=<id>&page=overview|lost|emergency|wifi|settings`). **Overview:** name, "Online · seen now" / "Last seen HH:MM", board model, battery, Wi-Fi, firmware; Quick actions "Find · Play sound" (→ `find`; 409 → "Aelys is offline"), "Lost mode · On|Off", "Emergency · {n} contacts"; rows to Wi-Fi networks and Device settings. Poll `state(id)` every 5 s while visible. **Lost mode setup:** live `RoundPreview` (466-px circle scaled, same texts as the device), Message (≤ 60, design limit), toggles Phone / Telegram (values from `contacts`) / Email (owner's account email), "QR code opens" Telegram|Phone|None, primary "Turn on lost mode". **Lost mode on:** "since HH:MM", "Last seen HH:MM", `On Wi-Fi “{current}”`, the no-GPS note, "Play sound", preview, "Turn off lost mode" / "Requires your fingerprint" (subtitle omitted in a plain browser, where no fingerprint is asked) → `ReauthSheet` ("Confirm it's you" + subtitle; "Use PIN instead" shown only on native hosts where the OS offers it, else hidden; "Cancel") → `reauth('lost_off', id)` → `setLost(id, {on:false, reauth})`.

- [ ] **Step 1: Failing tests:** `list shows status line from state`; `find offline shows "Aelys is offline"`; `turn on sends message and toggles`; `message input stops at 60 characters`; `turn off asks for reauth and sends it`; `reauth cancel sends nothing`.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck; screenshots at 390 px and desktop vs frames 1–2.
- [ ] **Step 5: Commit** `feat(web): add the Aelys device overview and lost mode pages`.

### Task W6: Emergency, Wi-Fi, device settings — model: **sonnet** · board: no · pre-plan-2: yes (mocks of B1 shapes)

**Files:** Create `views/settings/devices/{EmergencyPage.tsx,WifiPage.tsx,DeviceSettingsPage.tsx}`, `tests/companion-pages-2.test.tsx`. Modify `devices.css`, `CompanionOverview.tsx` (links).

**Behaviour (design frames 3–5; SOS frames are not built):** **Emergency:** contacts (name, relation, phone; "Add contact" hidden at 2), Medical notes (≤ 96), "Show on Aelys card": Your name / Contacts / Medical notes → `setIce`. Stored ICE values come from the server state (`ice`). **Wi-Fi:** saved list from `wifi.saved` with "Connected"/"Saved", up/down reordering by drag (pointer events; keyboard: move up/down buttons for accessibility) → `orderWifi`, swipe/× Remove → `removeWifi`; "Add network": "Nearby · seen by Aelys" from `scanWifi` + polling `last_wifi_scan`, Network name + Password → `encryptWifi(public_key, id, …)` → `addWifi` → states "Sending to Aelys…" → "Aelys is connecting…" → "Connected" / error frame "Wrong password for {ssid}" with "Try again" / "Remove", driven by polling `command_log` for the returned `command_id` (2 s, ≤ 60 s). Password never stored, logged or put in a URL; field cleared after send. Footer text verbatim. **Device settings:** Brightness slider (5–100, debounced 400 ms → `setSettings`); static row "Notifications on Aelys · Tasks, Calendar, Focus · Titles only · always"; Firmware "Version {fw_version}" (no update controls — plan 4); "Restart Aelys" → `restart`; "Unpair Aelys" (danger, design text) → `ReauthSheet` → `unpair` → back to the Devices list. Rows Sleep after, Night hours, Sounds, Emotions, Other apps, Update automatically and Name are **not rendered** in v1 (no firmware behind them yet — plan 4).

- [ ] **Step 1: Failing tests:** `ice save sends relation and show flags`; `add network encrypts and never sends the password in clear` (spy on request bodies: no password substring); `wrong password state from command_log`; `reorder sends new order`; `brightness debounced`; `unpair needs reauth`.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck; screenshots vs frames 3–5.
- [ ] **Step 5: Commit** `feat(web): add the Aelys emergency, Wi-Fi and device settings pages`.

### Task T1: End-to-end with the owner and docs — model: **sonnet** · board: **slot 8** · pre-plan-2: no

**Files:** Modify `firmware/companion/docs/next-steps.md` (carry-over items done; new carry-over for plan 4), `firmware/companion/docs/budgets.md`, `firmware/companion/README.md` (pairing, link, commands), `docs/API_CONTRACTS.md` (link to protocol v1.1 if plan 2 added a companion section).

- [ ] **Step 1: Fresh-main build** — after merging `feat/companion-link` into `main` (owner's rule), build firmware from `main`, flash (slot 8).
- [ ] **Step 2: Owner run-through** (owner types codes and passwords): unpair → re-pair via Add companion; Today/Aelys/Focus live; each action; lost mode on/off with fingerprint (Android or Mac app) and on web; ICE with Cyrillic names; find; Wi-Fi add (right + wrong password), scan, remove, reorder; brightness; restart; offline cache after pulling the router; revoke from the app → board unpaired.
- [ ] **Step 3: Budgets** — 1-hour online run: steady heap ≥ 80 KB, heap at reconnect, idle fps, image size; update `budgets.md` (PASS/FAIL as measured).
- [ ] **Step 4: Commit** `docs(firmware): record link budgets and plan 4 carry-over`.

---

## Out of scope (plan 4 or later)

OTA and firmware update UI; coredump upload; power management (sleep after, night hours, dim, IMU face-down) and their settings rows; Sounds/Emotions/Other-apps/Name rows; focus break timer; menu wheel and other device apps (timer, weather, English, games, voice); SOS (proposal); USB pairing from the Mac app (no Web Serial in WKWebView); NVS encryption (owner decision, §4.8).

## Execution notes for the controller

- Two lanes can run in parallel without the board: firmware logic (F1 → F2, F3, F4, F5 code) and web (W1 → W2 → W4, W3, W5, W6). Board slots 1–8 strictly in order, never overlapping plan 4.
- F7 needs: plan 2 merged and deployed, B1 not required (v1 is enough to connect); F9a/F9b need B1 deployed for the v1.1 commands.
- Each board step that needs the owner (codes, passwords, router, fingerprint) pauses and asks; agents never type the owner's secrets.
- If `esp_websocket_client` or `es8311` does not build on IDF 6.1, stop and report — do not fork or patch the component without the controller's decision.
