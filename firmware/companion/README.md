# Aelys companion firmware

ESP-IDF v6.1 firmware for the Waveshare ESP32-S3-Touch-AMOLED-1.75C. Rules: see `AGENTS.md`.

```sh
. ~/esp/esp-idf/export.sh
cp main/owner_contact.example.h main/owner_contact.local.h   # then fill in real contacts (git-ignored)
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/cu.usbmodem101 flash
python3 tools/serlog.py --seconds 8 --reset                    # PORT=... overrides the port
```

Wi-Fi is set up over USB with Improv Serial (the password is asked with `getpass`, never an argument):

```sh
python3 tools/improv_send.py --ssid "My network"   # PORT=... overrides the port
python3 tools/improv_send.py --state               # or --info: ask the board, no password
```

`CONFIG_AELYS_TZ` (default `<+05>-5`) sets the clock's time zone; `CONFIG_AELYS_NO_WIFI` keeps the radio off.

## Pairing over USB

The board pairs through four Improv vendor RPCs (0xA0 PAIR_BEGIN, 0xA1 PAIR_CODE, 0xA2 PAIR_COMMIT, 0xA3 PAIR_STATUS). The web app drives them over Web Serial (Settings, Devices, Add companion); `tools/improv_pair.py` does the same from the Mac and prints the 6-digit code to compare with the round screen:

```sh
.venv/bin/python firmware/companion/tools/improv_pair.py --secret-gen    # begin, code, print the digits
.venv/bin/python firmware/companion/tools/improv_pair.py --commit <device_id>
.venv/bin/python firmware/companion/tools/improv_pair.py --status
```

Pairing steps are refused in lost mode (error 0x80). Details: `docs/companion-protocol.md`.

## The link

`components/link` signs in by the device key (challenge, signature, login; no refresh token, so it signs in again when the access token expires) and keeps one `wss` channel to `/api/v1/devices/channel`. Commands with a `rev` (`lost_mode`, `ice_update`, `settings`) apply only when the `rev` is newer than the stored one, and are always acked. The pairing is wiped only when a challenge answers 401 `UNAUTHORIZED`; every other failure (DNS, TLS, 429, 5xx, close 4401/4403) only backs off. State is cached in NVS and shown offline. Contract: `docs/companion-protocol.md`.

## Device commands

Sent by the owner's app, run on the board: `lost_mode`, `ice_update`, `settings` (brightness), `restart`, `unpair`, `play_sound` (Find), `wifi_add`, `wifi_scan`, `wifi_remove`, `wifi_order`. Message shapes and error codes are in `docs/companion-protocol.md` (see "Plan 3 additions (v1.1)").

The owner run-through and open board checks: `docs/link-checklist.md`. Remaining work: `docs/next-steps.md`.
