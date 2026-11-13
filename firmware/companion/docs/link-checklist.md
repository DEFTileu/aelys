# Plan 3 owner run-through (companion link)

Tick each box as you go. "Agent" steps are run by the coding agent on the board; "you" steps need your hands (codes, passwords, router, fingerprint, ears). Flash only with `idf.py -p $PORT app-flash` (keeps the saved Wi-Fi). Nothing here is done yet: the board has not been online since the link code was written.

## 0. Before anything else

- [ ] Fresh `sdkconfig`: delete `firmware/companion/sdkconfig` and rebuild (`sdkconfig.defaults` only applies to new keys). A stale one stops the build with an `#error` in `main/app_main.c`.
- [ ] The board can see your saved Wi-Fi. It currently reports "AP not found" (reason 201), also with the pre-link firmware, so it is the network, not the code. Check the router, the band (2.4 GHz only) and the distance.
- [ ] Back end with the plan 3 routes is deployed to production. Check: an unauthenticated `GET https://api-production-1cea.up.railway.app/api/v1/companion/devices` answers 401, not 404 (404 means B1 is not deployed).
- [ ] A web build with the plan 3 pages is deployed (or running locally against that back end) and you can sign in to it. It needs the back end above; do not merge the web alone.
- [ ] `feat/companion-link` is merged into `main` and the firmware is built from fresh `main` (your rule), then flashed.

## 1. Agent-run board checks (board online)

- [ ] **Link check 1, DNS failure.** Pairing stays "paired", the link backs off, nothing is wiped. Expected: no unpair, reconnect tries spaced out.
- [ ] **Link check 2, unknown id on production.** A fake id is paired over USB against production; the board asks for a challenge. Expected: `401 UNAUTHORIZED`, the pairing is wiped (`PAIR_STATUS` = unpaired), board shows the first-boot screen. At most 3 attempts: a rate-limit courtesy to production, not a firmware limit. This is the first real test of the manual HTTP path.
- [ ] **TLS heap.** Every connect prints a `link connect heap_int=... largest=...` line. Expected: largest internal block >= 16 KB at every connect, `tls_fail` = 0.
- [ ] **No secrets in the log.** Grep the serial capture for the pairing code digits, `Bearer`, the Wi-Fi password: nothing.
- [ ] **F8, screens.** Swipe Today / Aelys / Focus; swipe latency <= 50 ms; idle fps unchanged. A task due in 30 minutes made in the app shows on Today within 5 s and the face worries; tapping its row completes it. Focus start / pause / resume / stop from the keys and the hold, visible in the app. A notice marked read in the Inbox. Expected: all work.
- [ ] **F8, offline.** Router off: "Offline / Showing data from HH:MM". Reboot offline: cached data shows, no stale focus session.
- [ ] **F8, key mapping.** The top key must start / pause Focus and the low key must go back. If reversed, swap the two `btn_feed` arguments in `board_input.c`.
- [ ] **F9a, lost mode and ICE.** Lost on with a Cyrillic message: lost screen within 2 s; key / tap shows "Only the owner can turn this off" for 2 s; reboot keeps lost mode; lost on while the board is off Wi-Fi arrives on reconnect; both buttons held 2 s open the ICE card; ICE changes show on the card and on the lost screen; brightness 20 % and 100 % visible and kept after a reboot; restart works.
- [ ] **F9b, Wi-Fi.** A second network is added and connects (card shows, command log ok, `wifi_state` lists both, the channel returns without waiting 30-75 s). Scan returns one entry per name, strongest first, up to 10, and the channel stays up. Remove / reorder show in `wifi_state`; removing the network in use keeps the connection. A scan during a reconnect does not strand the board. No password, blob or SSID-with-password in the serial log. Link task stack high-water during `wifi_add`. In lost mode: no card, the command still runs.
- [ ] **F9c, Find.** Audible 2 kHz beeps 200 ms on / 200 ms off, "Here I am!" overlay; no click or pop at start, edges or end, no hiss after; tap, either key or the two-button hold stops it within ~0.1 s and the tap does nothing underneath; it stops by itself at 60 s; 5 start / stop cycles in a row leave `heap_int` unchanged and no codec or I2S error; a second request while playing restarts the 60 s; a request right after a stop plays again; works over the lost screen and the ICE card; touch, battery and brightness still work while it plays. If `stack_free` in the `audio: end` line is below ~800 B raise `AUDIO_TASK_STACK`.
- [ ] **Battery gauge.** `battery_pct` reaches the server (the AXP2101 reads were written from the datasheet and never run).
- [ ] **Heap run (30 min to 1 h).** Scratch build with `CONFIG_AELYS_LINK_CHAOS_S=60` and `CONFIG_AELYS_METRICS_PERIOD_S=10`. Record in `budgets.md`: steady `heap_int` (target >= 80 KB), `heap_int_min` (it was 41 KB offline on the old image, lower than the 62 KB seen in plan 1: find out why), min `largest`, `heap_at_connect_min`, `tls_fail`, idle fps, `hwm_ui`, `hwm_input`, `hwm_link`, `hwm_ws`. Then trim the link (8192 B) and ws (6144 B) stacks to the measured mark plus margin. FAIL is reported, not tuned away.
- [ ] **Budgets.** Fill the PENDING rows in `budgets.md`: reconnect heap, touch to swipe, idle fps with the companion screens.

## 2. Your hands

- [ ] **Compare the pairing code.** During pairing the 6 digits on the round screen equal the 6 digits in the web page and the line `improv_pair.py` prints.
- [ ] **Pair.** The board must be unpaired (Check 2 leaves it so), then in the web app: Settings, Devices, Add companion, plug the board in over USB, type the code. The board shows "Paired" and is online within 10 s (the overview shows Wi-Fi, battery, firmware).
- [ ] **Pair from the Mac app.** Same steps in the Mac app (it has no Web Serial, so it talks to the board through its own USB bridge): Settings, Devices, Add companion, "Connect Aelys" (no port chooser; with several boards plugged in it takes the first), type the code. Unplug the cable mid-pairing: the page shows an error and a replug followed by "Connect Aelys" starts over. The Android app keeps the "connect it by USB to Aelys on your Mac or on the web" hint.
- [ ] **Opening and closing the port does not reset the board.** Pairing finished, page closed mid-pairing, Mac app quit, and a Chrome pairing page closed: the board does not reboot and does not land in download mode (the app and the page lower RTS, then DTR, right after opening).
- [ ] **Today / Aelys / Focus live.** The app and the board agree after each action: complete a task, start / pause / stop Focus, mark a notice read.
- [ ] **Lost mode on and off.** On from the web and from the Mac app (or Android). Off asks for your fingerprint where the device has one. Check the QR / contact toggles on the lost screen.
- [ ] **ICE with Cyrillic names.** Save an emergency contact with a Cyrillic (and Kazakh) name and relation; the ICE card and lost screen show them without missing letters or cut-off bytes.
- [ ] **Find.** Press Find in the app and listen: loudness (`BEEP_VOLUME 80`), harshness. Say if it needs tuning.
- [ ] **Wi-Fi.** Add a network with the right password and one with a wrong password (you type both, the agent never does): right one connects, wrong one shows "Wrong password" and the board stays on the old network. Scan, remove, reorder.
- [ ] **Brightness and Restart** from the app.
- [ ] **Unpair from the app.** The board lands on the first-boot screen, the device is gone from the app, and the saved Wi-Fi list is empty (the command erases it on purpose). You do this, and you re-provision your own Wi-Fi afterwards over USB Improv (`tools/improv_send.py`); an agent never erases or re-provisions Wi-Fi. Pair again after that.
- [ ] **Offline cache.** Pull the router's power; the board shows the cached day and "Offline". Plug it back in: the board returns on its own, with no restart.
- [ ] **Revoke.** Revoke the device from the app (not Unpair, which erases Wi-Fi): the board shows the welcome screen right away; after a reboot with the Wi-Fi still saved it shows "Not paired yet". Pair it again.
- [ ] **Look at the pages.** Web at phone width (390 px) and desktop: Add companion, overview, Lost mode, Emergency, Wi-Fi (the tightest rows), Device settings. No agent has seen these in a browser.

## 3. Decisions for you

- [ ] **Invented copy** (not in the designs): sign off or change.
  - Add companion: "Connect Aelys" button; "This USB device is not Aelys...", "Aelys did not answer...", "The code expired...", "Aelys is online on {ssid}"; hand-drawn USB and smartphone icons.
  - Overview and Lost mode: "Not set", "-" for missing values, "Offline", "1 contact", "Couldn't load your devices...", "Couldn't reach Aelys...", stand-in icons (no Fingerprint / Phone / QR glyphs); the lost-mode preview QR is a look-alike, not scannable; "Use PIN instead" left out.
  - Emergency and Wi-Fi: "Save" / "Saved", "Each contact needs a name and a phone number.", "New contact", "Tap to edit", "Couldn't add {ssid}", "Restarting...", the two byte-limit messages; no swipe-to-remove, no contact reordering, no signal-bar icons.
  - Board: "All day", "Inbox · {n}", "Offline / Showing data from HH:MM", "Didn't work — try again", "Here I am!", "Playing sound · tap to stop", "Only the owner can turn this off", "New Wi-Fi from phone / Connecting", "Wrong password / still on {ssid}"; no icons anywhere (no icon font).
  - Mac app: the fingerprint prompt text is the generic "unlock the saved session" line.
- [ ] **A lost board that lost its pairing.** The app blocks Unpair while lost mode is on, but a board that is already unpaired and in lost mode refuses re-pairing (PAIR_BEGIN returns 0x80) and then needs USB recovery. Allow pairing on an unpaired lost board, or keep refusing?
- [ ] **Unpair also clears lost mode** (the firmware does this, as built in F9a; confirm it is what you want. The contract says lost mode survives the 401 wipe; the unpair command erases it with everything else). Keep?
- [ ] **Android and Macs without Touch ID** sign the "lost off" challenge without any fingerprint prompt. Accept, or require a prompt before plan 4?
- [ ] **PWR = top key, BOOT = low key** is an assumption until step 1 confirms it.
- [ ] **Find always plays**: there is no Sound setting yet, and no screen sleep. Fine until plan 4?
- [ ] **Wi-Fi passwords stay unencrypted in NVS** until you decide on NVS encryption (spec 4.8, needs an eFuse burn).
