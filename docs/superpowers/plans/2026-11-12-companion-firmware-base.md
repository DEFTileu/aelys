# Aelys Companion — firmware base (plan 1 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Own C firmware on the Waveshare ESP32-S3-Touch-AMOLED-1.75C: the board boots into the Aelys face + clock, keeps time over Wi-Fi (SNTP), takes Wi-Fi over USB (Improv Serial), and offline shows the lost-mode screen and the ICE card with the owner's contacts.

**Architecture:** ESP-IDF v6.1 project `firmware/companion/`. Pure C logic and LVGL screens live in components that build on the host too (`components/ui`, `components/logic`), so they are tested with ctest and screenshotted headless; `components/board` and `main` hold everything that touches IDF/hardware. One `ui` task on core 1 owns LVGL; everything else posts ≤64-byte events to it.

**Tech Stack:** ESP-IDF v6.1, C11, LVGL 9.6.0, `espressif/esp_lcd_co5300` 2.2.0, `waveshare/esp_lcd_touch_cst9217` 2.0.0, host CMake + ctest.

**Spec:** `docs/superpowers/specs/2026-11-12-esp32-companion-design.md` (§3, §4.1–4.3, §4.6–4.11). Visual source: `ACTUAL AELYS Companion.dc.html` and `CompanionFace.dc.html` in `/private/tmp/claude-501/-Users-tileuzhan--claude-spares-spare-ZFjiNm/0546fcd4-9c8c-4d7c-81ac-da219f6d5fcf/scratchpad/live/project/` (local copies of the owner's design project; device text is English).

**Roadmap (separate plans, written after this one ships):** 2 — backend: ADR, `companion` platform, scope, signature login, `/devices/channel`, agenda route, §4.11 message types. 3 — pairing via the web “Add companion” USB page, AUTH, snapshot/patch, actions, app Settings → Devices → Aelys, and the §4.11 channel commands (`lost_mode`, `ice_update`, `play_sound` with the ES8311 speaker, `wifi_add` ECIES-encrypted to the device key, `wifi_scan`). 4 — OTA with rollback, coredump upload, power management (dim/off, IMU face-down), CI build.

## Global Constraints

- ESP-IDF **v6.1**; C11 for all code; no C++, no Arduino, no Brookesia, no BLE, no cJSON, no `esp_lvgl_port` (own LVGL port).
- Registry deps pinned exactly in `idf_component.yml`; `dependencies.lock` committed; `sdkconfig` NOT committed (only `sdkconfig.defaults`).
- Partitions (32 MB): `nvs` 24K, `otadata` 8K, `phy_init` 4K, `ota_0` 4M, `ota_1` 4M, `coredump` 64K, `storage` (LittleFS) = rest.
- LVGL: PARTIAL mode, two buffers of 466×32 px RGB565 in `MALLOC_CAP_INTERNAL|MALLOC_CAP_DMA`, flush synced to panel TE, LVGL heap in PSRAM. Only the `ui` task (core 1, prio 6) calls LVGL. No malloc, locks or logs in the render path.
- `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=2048`; `-O2` (`CONFIG_COMPILER_OPTIMIZATION_PERF`); 240 MHz; `CONFIG_ESP_TASK_WDT_PANIC=y`; coredump to flash; release log level WARN.
- Owner contacts come only from git-ignored `firmware/companion/main/owner_contact.local.h` (`OWNER_PHONE`, `OWNER_TELEGRAM`, `OWNER_QR_URL`); the repo is PUBLIC — never write those values into a tracked file, commit message or log line.
- Board permissions (owner, one-time yes): reboot, backup, flashing app/OTA partitions. **Never** without a fresh explicit yes: any eFuse command, `erase-flash`, deleting the backup.
- Budgets to measure (spec §4.6): 60 fps animation, worst frame ≤ 25 ms, touch → screen ≤ 50 ms, cold boot → clock ≤ 1.5 s, app internal RAM (without Wi-Fi) ≤ 100 KB, free internal heap with Wi-Fi ≥ 80 KB, image ≤ 2 MB.
- Device UI copy is English; the character is named **Aelys**.
- Git: branch `feat/companion-firmware` in a worktree; Conventional Commits per `docs/GIT_WORKFLOW.md`; stage explicit paths only.
- Serial port: env `PORT`, default `/dev/cu.usbmodem1101`; every script fails with a clear message if the port is missing.

## Review Focus

1. **Board not plugged in / different port** → scripts stop with “board not found on $PORT” instead of a Python traceback. (Task 2: `serlog.py` test.)
2. **Fresh clone or worktree without `owner_contact.local.h`** → CMake fails naming `owner_contact.example.h` as the template. (Task 2.)
3. **Long owner text** (64-char message, 32-char handle) on a round 466 px screen → ellipsised, never drawn outside the circle. (Task 6: sim screenshot with max-length fields.)
4. **Empty or corrupt NVS record** (wrong version, short blob) → factory owner contacts shown, no crash, no reboot loop. (Task 7: `test_store_corrupt_blob_falls_back`.)
5. **Both-buttons hold vs. PWR power-off** → 2 s hold opens ICE and never powers the board off; releasing either button early cancels; PWR alone keeps its normal behaviour. (Task 5: combo tests + AXP2101 power-off time ≥ 6 s.)

---

### Task 1: Toolchain and board backup — model: **haiku**

**Files:** none in the repo. Backup goes to `~/aelys-backups/companion/` (outside git).

- [ ] **Step 1: Install ESP-IDF v6.1** into `~/esp/` with the Espressif Installation Manager CLI (`eim install -i v6.1`, EIM from `brew install espressif/eim/eim` or Espressif’s release page); fallback `git clone -b v6.1 --recursive --depth 1 https://github.com/espressif/esp-idf ~/esp/esp-idf && ~/esp/esp-idf/install.sh esp32s3`. Record the activation command (EIM activation script or `. ~/esp/esp-idf/export.sh`) in your report.
- [ ] **Step 2: Verify** — run: `<activate> && idf.py --version` → expected `ESP-IDF v6.1…`.
- [ ] **Step 3: Board present** — run: `ls /dev/cu.usbmodem*`. If nothing: stop and report “plug the board in over USB-C” (do not continue).
- [ ] **Step 4: Security info** — run: `esptool.py --chip esp32s3 -p $PORT get-security-info` (or `esptool … get-security-info` on esptool v5). Save output to `~/aelys-backups/companion/security-info.txt`. Report whether flash encryption / secure boot are enabled (expected: both off).
- [ ] **Step 5: Full backup** — run: `esptool --chip esp32s3 -p $PORT -b 921600 read-flash 0 ALL ~/aelys-backups/companion/backup_7C0C5F424844.bin`, then `shasum -a 256` it into `backup_7C0C5F424844.sha256`. Expected size 33554432 bytes.
- [ ] **Step 6: Verify backup against the chip** — run: `esptool --chip esp32s3 -p $PORT verify-flash 0 ~/aelys-backups/companion/backup_7C0C5F424844.bin` → expected “Verification successful”. `chmod 400` the .bin. No commit.

### Task 2: IDF project skeleton — model: **sonnet**

**Files:**
- Create: `firmware/companion/{CMakeLists.txt,partitions.csv,sdkconfig.defaults,AGENTS.md,.gitignore,README.md}`
- Create: `firmware/companion/main/{CMakeLists.txt,idf_component.yml,app_main.c,owner_contact.example.h}`
- Create: `firmware/companion/tools/serlog.py`
- Commit also (already written, untracked/modified in the main checkout — copy into the worktree): `docs/superpowers/specs/2026-11-12-esp32-companion-design.md`, this plan, the `.gitignore` rule `firmware/companion/**/*.local.h`.

**Interfaces:**
- Produces: `idf.py build` from `firmware/companion/`; `python3 tools/serlog.py [--seconds N] [--reset]` prints serial output for N s (default 15), exit 2 with `board not found on <port>` if the port is absent.
- Produces: `owner_contact.h` include convention — code includes `"owner_contact.local.h"`; `main/CMakeLists.txt` checks `EXISTS` and fails with `message(FATAL_ERROR "Copy main/owner_contact.example.h to main/owner_contact.local.h and fill in the owner's contacts")`.

- [ ] **Step 1: Worktree** — `git worktree add .worktrees/companion -b feat/companion-firmware` (check `.worktrees/` is ignored; add it to `.gitignore` if not). Copy the git-ignored `firmware/companion/main/owner_contact.local.h` from the main checkout into the worktree. Copy the spec, this plan and the `.gitignore` rule in.
- [ ] **Step 2: Failing guard test** — in the worktree, temporarily move `owner_contact.local.h` away, run `idf.py set-target esp32s3 && idf.py reconfigure` → expected FAIL with the FATAL_ERROR text above. Move it back.
- [ ] **Step 3: Write the skeleton.** `partitions.csv` exactly per Global Constraints (offset of `nvs` 0x9000). `sdkconfig.defaults`: flash 32 MB QIO 80 MHz, octal PSRAM 80 MHz with `CONFIG_SPIRAM_MEMTEST=n` (boot time), `SPIRAM_MALLOC_ALWAYSINTERNAL=2048`, `SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y`, CPU 240 MHz, `COMPILER_OPTIMIZATION_PERF`, D-cache 64 KB line 64 B, I-cache 32 KB, task WDT panic, coredump to flash (ELF), custom partition table, `ESP_MAIN_TASK_AFFINITY_CPU1=n` (UI task is created explicitly), mbedTLS dynamic buffers (`MBEDTLS_DYNAMIC_BUFFER`, `…FREE_CONFIG_DATA`, `…FREE_CA_CERT`), console on USB-Serial/JTAG. `idf_component.yml`: `idf: "6.1.*"`, `lvgl/lvgl: "9.6.0"`, `espressif/esp_lcd_co5300: "2.2.0"`, `waveshare/esp_lcd_touch_cst9217: "2.0.0"`. `app_main.c`: log firmware version, `heap_caps_get_free_size` for INTERNAL and SPIRAM, `esp_psram_get_size()`. `AGENTS.md`: the board-permission rule and the owner-contact rule from Global Constraints. `.gitignore`: `build/`, `managed_components/`, `sdkconfig`, `sdkconfig.old`, `sim/build/`, `sim/out/`.
- [ ] **Step 4: Build** — `idf.py build` → PASS; `idf.py size` → app ≤ 2 MB. Commit `dependencies.lock`.
- [ ] **Step 5: Flash and read** — `idf.py -p $PORT flash && python3 tools/serlog.py --seconds 8 --reset` → expected log line with PSRAM size `8388608` and free internal heap. Then `PORT=/dev/nope python3 tools/serlog.py` → exit 2, `board not found on /dev/nope`.
- [ ] **Step 6: Commit** — `docs(companion): add firmware design spec and plan` (spec, plan, .gitignore) then `build(firmware): scaffold companion ESP-IDF project` (firmware/companion).

### Task 3: Display + own LVGL port — model: **sonnet**

**Files:**
- Create: `firmware/companion/components/board/{CMakeLists.txt,include/board.h,include/board_pins.h,board_i2c.c,board_power.c,board_display.c,lv_port.c}`
- Create: `firmware/companion/components/logic/{CMakeLists.txt,include/ui_events.h}` (pure C, no IDF; later tasks add files here)
- Modify: `firmware/companion/main/app_main.c`

**Interfaces:**
- Consumes: Task 2 project.
- Produces (`board.h`):
  - `esp_err_t board_init(void);` — I2C master bus, AXP2101 rails for the panel, panel reset/init.
  - `i2c_master_bus_handle_t board_i2c_bus(void);`
  - `esp_err_t lv_port_start(void (*ui_setup)(void));` — creates the `ui` task (core 1, prio 6), inits LVGL, display, buffers, then calls `ui_setup()` inside that task and loops `lv_timer_handler()`.
  - `void lv_port_post(const ui_event_t *ev);` — non-blocking enqueue (queue depth 16) from any task; drained in the `ui` task, which calls the handler set by `lv_port_set_handler(void (*fn)(const ui_event_t *))`.
  - `ui_events.h`: `typedef enum { UI_EV_TOUCH = 1, UI_EV_BTN, UI_EV_COMBO_PROGRESS, UI_EV_COMBO_FIRE, UI_EV_TIME, UI_EV_WIFI, UI_EV_OWNER, UI_EV_LOST, UI_EV_TICK } ui_event_type_t;` `typedef struct { uint8_t type; uint8_t len; uint8_t data[62]; } ui_event_t;` `_Static_assert(sizeof(ui_event_t) == 64, "ui_event_t");`
  - `void lv_port_frame_stats(uint32_t *fps_x10, uint32_t *worst_us);` — rolling 5 s window.

- [ ] **Step 1: Pin map** — download BSP `waveshare/esp32_s3_touch_amoled_1_75c` 3.0.0 into a scratch dir (not the repo), copy the LCD QSPI (CS, PCLK, DATA0–3, RST, TE=13 confirmed in prior art), I2C SDA/SCL, touch INT/RST, BOOT key (GPIO0) values into `board_pins.h` with a comment naming the BSP version as source. AXP2101 at 0x34; QMI8658 at 0x6B or 0x6A.
- [ ] **Step 2: Panel** — CO5300 over QSPI via `esp_lcd_co5300` (init sequence from the BSP), pclk 80 MHz (fall back to 40 MHz if the image tears or corrupts; record which works). LVGL display 466×466 RGB565, `LV_DISPLAY_RENDER_MODE_PARTIAL`, two 466×32 buffers in internal DMA RAM, byte-swapped in LVGL (`LV_COLOR_FORMAT_RGB565_SWAPPED` or flush-time swap — pick the one with no per-pixel loop in flush). Add an invalidate-area rounder so x1/y1 are even and x2/y2 odd (CO5300 requires 2-px aligned windows). Flush waits for the TE edge (GPIO ISR → task notification) before sending the first chunk of a frame. LVGL memory: `LV_USE_STDLIB_MALLOC` custom → `heap_caps_malloc(…, MALLOC_CAP_SPIRAM)`.
- [ ] **Step 3: On-device test** — temporary `ui_setup` that animates a 120 px circle across the screen continuously; log `fps_x10` and `worst_us` every 5 s. Flash, `serlog.py --seconds 20` → expected fps ≥ 55.0 and worst ≤ 25000 µs. Report the numbers. If below: try (in order) pclk, buffer rows 466×48, `LV_ATTRIBUTE_FAST_MEM` in IRAM, and report each result.
- [ ] **Step 4: Commit** — `feat(firmware): drive CO5300 panel with own LVGL port`.

### Task 4: Host build of UI + Aelys face — model: **sonnet**

**Files:**
- Create: `firmware/companion/components/ui/{CMakeLists.txt,include/ui.h,include/ui_events.h,face.c,face_moods.c,theme.c,fonts/}`
- Create: `firmware/companion/sim/{CMakeLists.txt,sim_main.c,bmp.c}`
- Create: `firmware/companion/components/ui/fonts/README.md` (how fonts were generated)

**Interfaces:**
- Consumes: `ui_events.h` from `components/logic` (Task 3). Dependency direction: `ui` → `logic`, `board` → `logic`; `logic` depends on nothing.
- Produces (`ui.h`): `typedef enum { MOOD_CALM, MOOD_HAPPY, MOOD_PROUD, MOOD_FOCUSED, MOOD_WORRIED, MOOD_SAD, MOOD_SURPRISED, MOOD_CURIOUS, MOOD_SLEEPY, MOOD_SLEEPING, MOOD_DIZZY, MOOD_ANNOYED, MOOD_LOVE, MOOD_OFFLINE, MOOD_COUNT } mood_t;` `lv_obj_t *face_create(lv_obj_t *parent, int32_t scale_x100);` `void face_set_mood(lv_obj_t *face, mood_t m);` `const char *mood_name(mood_t m);`
- Produces (sim): `./sim/build/companion_sim --shot <screen> --out <file.bmp>` renders one screen headless at 466×466 and writes a 24-bit BMP; `ctest` runs host unit tests.
- `components/ui` includes only `lvgl.h`, `ui*.h` and the C standard library — no IDF headers (the sim build proves this).

- [ ] **Step 1: Failing test** — `sim/` ctest `test_face_moods`: for every `mood_t` from 0 to `MOOD_COUNT-1`, `face_create` + `face_set_mood` returns non-NULL, `mood_name(m)` is non-empty and unique. Build sim with LVGL 9.6.0 fetched by CMake `FetchContent` (tag `v9.6.0`) and a sim `lv_conf.h` matching the firmware one. Run `ctest` → FAIL (no face.c).
- [ ] **Step 2: Implement the face** from `CompanionFace.dc.html`: the `MOODS` table there (eye w/h/radius/offsets/lid/tilt/smile/hollow + fx cheeks/glyph/zz/sweat/sparkle/dots) is the source of truth; at scale 1 the face is 280×160 px. Blink: 5.2 s cycle, lids close to 8 % for ~150 ms, not for sleeping/dizzy/offline. Colours from that file (`#F4F1FF` eyes on `#000`, accent `#B9A8FF`). Use plain `lv_obj` rectangles with radius; no shadows, no opacity layers, no transforms on large areas.
- [ ] **Step 3: Fonts** — generate Inter A8 bitmap fonts with `npx lv_font_conv@1.5.2` (sizes 20, 28, 40, 96 for the clock digits; ranges ASCII 0x20–0x7E + `·…—`), commit the `.c` files and the exact commands in `fonts/README.md`.
- [ ] **Step 4: Tests pass + screenshot** — `ctest` → PASS. `companion_sim --shot face:<mood>` for all 14 moods into `sim/out/` (git-ignored). Attach 3 of them (calm, happy, sleeping) in your report.
- [ ] **Step 5: Commit** — `feat(firmware): add Aelys face and host UI simulator`.

### Task 5: Touch, buttons, both-buttons combo — model: **sonnet**

**Files:**
- Create: `firmware/companion/components/logic/{include/combo.h,combo.c}`
- Create: `firmware/companion/sim/test_combo.c`
- Create: `firmware/companion/components/board/{board_input.c}`; Modify: `board.h`

**Interfaces:**
- Produces (`combo.h`, pure C, no IDF):
  ```c
  typedef enum { COMBO_IDLE, COMBO_HOLDING, COMBO_FIRED } combo_state_t;
  typedef struct { combo_state_t state; uint32_t since_ms; bool a, b; } combo_t;
  #define COMBO_HOLD_MS 2000
  void combo_reset(combo_t *c);
  /* returns progress 0..100 while holding, 100 exactly once when it fires, -1 otherwise */
  int combo_update(combo_t *c, bool a_down, bool b_down, uint32_t now_ms);
  ```
- Produces (`board.h`): `esp_err_t board_input_start(void);` — touch CST9217 → LVGL pointer indev; BOOT (GPIO0, active low, debounced 20 ms) + PWR key via AXP2101 PKEY positive/negative-edge IRQs; feeds `combo_update` every 20 ms; posts `UI_EV_BTN`, `UI_EV_COMBO_PROGRESS`, `UI_EV_COMBO_FIRE`.

- [ ] **Step 1: Failing tests** (`test_combo.c`):
  - `test_fires_after_2000ms`: both down from t=0; update at 1990 → progress < 100; at 2000 → returns 100; at 2100 → -1 (fires once).
  - `test_release_one_cancels`: both down 0–1500, a up at 1500, both down again at 1600 → fires only at 3600.
  - `test_single_button_never_fires`: only b down for 10 000 ms → never 100.
  - `test_refire_needs_release`: after firing, keep holding 5000 ms → no second 100; release both, hold again 2000 → fires.
- [ ] **Step 2: Run** `ctest -R combo` → FAIL.
- [ ] **Step 3: Implement `combo.c`.** Run → PASS.
- [ ] **Step 4: Board input** — CST9217 via `esp_lcd_touch_cst9217` on the shared I2C bus, INT pin as wake source later (plan 4). AXP2101: enable PKEY edge IRQs, set long-press power-off time to its maximum (≥ 6 s) so the 2 s combo can never power off; read and clear IRQ status in a 20 ms poll (no IRQ line needed). Touch → screen latency: log `esp_timer_get_time()` delta from touch read to the next flush end for 20 touches; report median and max (budget ≤ 50 ms).
- [ ] **Step 5: Commit** — `feat(firmware): add touch, buttons and two-button combo`.

### Task 6: Screens — home, lost mode, ICE card — model: **sonnet**

**Files:**
- Create: `firmware/companion/components/ui/{screens.c,scr_home.c,scr_lost.c,scr_ice.c,orbit.c}`; Modify: `ui.h`
- Create: `firmware/companion/components/logic/{include/owner.h,owner.c,include/screen_fsm.h,screen_fsm.c}`
- Create: `firmware/companion/sim/test_screen_fsm.c`

**Interfaces:**
- Produces (`owner.h`, pure):
  ```c
  typedef struct { char name[33]; char phone[24]; char telegram[33]; char qr_url[97]; char message[65]; char med_note[97];
                   char ice_name[2][33]; char ice_phone[2][24]; } owner_info_t;
  void owner_defaults(owner_info_t *o); /* fills phone/telegram/qr_url from owner_contact.local.h, message = "If found, please contact" */
  ```
  `owner.c` is the only file that includes `owner_contact.local.h`. The sim build includes `main/owner_contact.example.h` instead (`-DOWNER_CONTACT_HEADER=…`), so screenshots never contain the real number.
- Produces (`screen_fsm.h`, pure): `typedef enum { SCR_HOME, SCR_ICE, SCR_LOST } scr_t;` `scr_t screen_next(scr_t cur, bool lost_mode, ui_event_type_t ev);` Rules: combo fire → `SCR_ICE` from any screen (also from lost mode); tap or 15 s timeout on ICE → back to `SCR_LOST` if `lost_mode` else `SCR_HOME`; while `lost_mode`, nothing leaves `SCR_LOST` except combo → ICE; `UI_EV_LOST` on → `SCR_LOST`, off → `SCR_HOME`.
- Produces (`ui.h`): `void ui_setup(void);` (the `lv_port_start` callback) and `void ui_handle_event(const ui_event_t *ev);`

- [ ] **Step 1: Failing tests** (`test_screen_fsm.c`): `test_combo_opens_ice_from_home`, `test_combo_opens_ice_from_lost`, `test_ice_returns_to_lost_when_lost_mode`, `test_buttons_cannot_leave_lost` (BTN, TOUCH, COMBO_PROGRESS on `SCR_LOST` with lost_mode → `SCR_LOST`), `test_lost_off_goes_home`. Run → FAIL.
- [ ] **Step 2: Implement `screen_fsm.c` and `owner.c`.** Run → PASS.
- [ ] **Step 3: Screens** following the device frames of “ACTUAL AELYS Companion” (home: clock + face + task orbit from `CompanionOrbit.dc.html`; “10 · Безопасность”: lost mode with amber ring, contacts, QR, message; ICE card with red ring, name, 2 contacts, medical note; combo-progress ring filling over 2 s). QR: LVGL `lv_qrcode` (enable `LV_USE_QRCODE`) from `qr_url`. All text labels use `LV_LABEL_LONG_DOT` and widths that keep them inside the 466 px circle. No live data yet: the orbit shows 0/0 and the agenda line reads “Not paired yet”.
- [ ] **Step 4: Max-length screenshot** — sim test fills every `owner_info_t` field to its max length with `W` characters and renders `lost` and `ice`; a pixel check asserts every non-black pixel lies within radius 233 of the centre. `companion_sim --shot home|lost|ice|ice_progress` → attach all four.
- [ ] **Step 5: Device** — flash; check on the board: home shows, both buttons 2 s → ICE, tap → home. Report.
- [ ] **Step 6: Commit** — `feat(firmware): add home, lost-mode and ICE screens`.

### Task 7: Persistent settings (NVS) — model: **sonnet**

**Files:**
- Create: `firmware/companion/components/logic/{include/store_codec.h,store_codec.c}` (pure), `firmware/companion/sim/test_store.c`
- Create: `firmware/companion/main/store_nvs.c`, `firmware/companion/main/store_nvs.h`

**Interfaces:**
- Produces (pure codec, versioned blobs, version byte first, CRC32 last):
  ```c
  #define WIFI_MAX 5
  typedef struct { char ssid[33]; char pass[65]; } wifi_cred_t;
  typedef struct { uint8_t n; wifi_cred_t net[WIFI_MAX]; } wifi_list_t;
  typedef struct { bool on; owner_info_t shown; } lost_state_t;
  size_t store_encode_owner(const owner_info_t *in, uint8_t *buf, size_t cap);
  bool   store_decode_owner(const uint8_t *buf, size_t len, owner_info_t *out); /* false on bad version/len/crc */
  /* same pair for wifi_list_t and lost_state_t */
  bool wifi_list_upsert(wifi_list_t *l, const char *ssid, const char *pass); /* replaces same SSID; when full, drops the oldest */
  ```
- Produces (`store_nvs.h`): `void store_load_owner(owner_info_t *o)` (decode NVS blob, else `owner_defaults`), `store_save_owner`, `store_load_wifi`, `store_save_wifi`, `store_load_lost`, `store_save_lost`. Namespace `aelys`, keys `owner`, `wifi`, `lost`.

- [ ] **Step 1: Failing tests**: `test_store_roundtrip_owner`, `test_store_corrupt_blob_falls_back` (flip one byte → decode returns false; truncated → false; version 99 → false), `test_wifi_upsert_replaces_same_ssid`, `test_wifi_upsert_drops_oldest_when_full` (6th SSID evicts the 1st), `test_lost_roundtrip`. Run → FAIL.
- [ ] **Step 2: Implement codec** (CRC32 via a small table, no IDF). Run → PASS.
- [ ] **Step 3: NVS adapter + boot path**: on boot, load lost state → if on, start on `SCR_LOST`. Device check: write a lost-mode record via a temporary debug hook, reboot (`serlog.py --reset`) → board comes up on the lost screen. Remove the hook.
- [ ] **Step 4: Commit** — `feat(firmware): persist owner, Wi-Fi and lost-mode settings`.

### Task 8: Wi-Fi, SNTP, Improv Serial — model: **sonnet**

**Files:**
- Create: `firmware/companion/components/logic/{include/improv.h,improv.c}`, `firmware/companion/sim/test_improv.c`
- Create: `firmware/companion/components/net/{CMakeLists.txt,include/net.h,net_wifi.c,net_time.c,net_improv.c}`
- Create: `firmware/companion/main/Kconfig.projbuild` (`AELYS_TZ` string, default `"<+05>-5"`; `AELYS_NO_WIFI` bool, default n)
- Create: `firmware/companion/tools/improv_send.py`

**Interfaces:**
- Produces (pure Improv Serial v1 framing): `"IMPROV"` header, version 1, type, length, data, checksum = byte sum. `int improv_feed(improv_parser_t *p, uint8_t byte, improv_frame_t *out);` (returns 1 when a full valid frame is in `out`, 0 need more, -1 bad checksum — resets) and `size_t improv_build(uint8_t type, const uint8_t *data, size_t len, uint8_t *buf, size_t cap);` plus `bool improv_parse_wifi(const improv_frame_t *f, char ssid[33], char pass[65]);`
- Produces (`net.h`): `esp_err_t net_start(void);` — tries saved networks in order with backoff 1 s → 60 s + jitter; posts `UI_EV_WIFI` (`OFFLINE|CONNECTING|ONLINE|BAD_PASSWORD`); after IP starts SNTP (`pool.ntp.org`, TZ from `CONFIG_AELYS_TZ`, default `"<+05>-5"`), posts `UI_EV_TIME` each minute. Improv listener on the USB-Serial/JTAG console reads frames alongside logs; on “send Wi-Fi settings” it tries the network, replies provisioned / error “unable to connect”, and saves via `wifi_list_upsert` only on success.

- [ ] **Step 1: Failing tests** (`test_improv.c`): `test_build_then_parse_roundtrip`, `test_bad_checksum_rejected`, `test_garbage_before_header_skipped`, `test_parse_wifi_rpc` (RPC 0x01 with ssid “Office”, pass “p@ss word”), `test_oversized_ssid_rejected` (33+ chars → false). Run → FAIL.
- [ ] **Step 2: Implement `improv.c`.** Run → PASS.
- [ ] **Step 3: Net component** — Wi-Fi STA (`WIFI_PS_MIN_MODEM`), SNTP, Improv listener. Wrong password surfaces as `BAD_PASSWORD` within 15 s and the board keeps running (no reboot).
- [ ] **Step 4: `tools/improv_send.py`** — `--ssid`, password read with `getpass` (never a CLI argument, never logged), sends the Improv RPC and prints the device's reply.
- [ ] **Step 5: Device check with the owner** — the owner runs `improv_send.py` themselves and types their Wi-Fi password; expected: reply “provisioned”, clock on screen shows correct local time within 10 s; reboot → reconnects without provisioning. Also send a wrong password → “unable to connect”, screen shows the Wi-Fi error, board stays up.
- [ ] **Step 6: Commit** — `feat(firmware): add Wi-Fi, SNTP and Improv provisioning`.

### Task 9: Metrics and budget report — model: **haiku**

**Files:**
- Create: `firmware/companion/main/metrics.c`, `metrics.h`; `firmware/companion/docs/budgets.md`

**Interfaces:**
- Consumes: `lv_port_frame_stats` (Task 3).
- Produces: `void metrics_start(uint32_t period_s);` — logs at WARN one line `metrics heap_int=… heap_int_min=… largest=… psram=… fps=… worst_us=… hwm_ui=… hwm_net=… boot_ms=…` every period (60 s in release; plan 3 will send it to the backend).

- [ ] **Step 1: Implement** with `heap_caps_get_free_size`, `heap_caps_get_minimum_free_size`, `heap_caps_get_largest_free_block` (INTERNAL), SPIRAM free, `uxTaskGetStackHighWaterMark` (bytes on S3), `boot_ms` = `esp_timer_get_time()` when the first home frame is flushed.
- [ ] **Step 2: Measure on the board** — 10 minutes on home screen online: collect the metrics lines (`serlog.py --seconds 600`). Then once more built with `CONFIG_AELYS_NO_WIFI=y` (via an extra `sdkconfig.nowifi` defaults file, not committed) for “app internal RAM without Wi-Fi”.
- [ ] **Step 3: Write `docs/budgets.md`** — table: each §4.6 budget, measured value, PASS/FAIL, how measured. FAILs are reported, not hidden or tuned away silently.
- [ ] **Step 4: Commit** — `perf(firmware): log runtime metrics and record budgets`.

---

## Execution notes for the controller

- Hardware steps (Task 1, 2 Step 5, 3 Step 3, 5 Step 4, 6 Step 5, 7 Step 3, 8 Step 5, 9 Step 2) need the board on USB-C; if `/dev/cu.usbmodem*` is missing, pause and ask the owner to plug it in.
- Task 8 Step 5 needs the owner at the keyboard (their Wi-Fi password never passes through an agent).
- Merge `feat/companion-firmware` into `main` only after the owner looks at the board; per the owner's rule, builds for release come from fresh `main`.
