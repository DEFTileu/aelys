# Companion firmware rules

Own C firmware (ESP-IDF v6.1) for the Waveshare ESP32-S3-Touch-AMOLED-1.75C.

## Board permissions

- Allowed with the owner's standing yes: reboot, read-only backup, flashing the app and OTA partitions.
- Never without a fresh explicit yes from the owner: any eFuse command, `erase-flash` (including `idf.py erase-flash`), deleting the backup in `~/aelys-backups/companion/`.

## Owner contacts

- Owner contacts (`OWNER_PHONE`, `OWNER_TELEGRAM`, `OWNER_QR_URL`) live only in the git-ignored `main/owner_contact.local.h`. Template: `main/owner_contact.example.h`.
- The repository is public: never write those values into a tracked file, a commit message, a report or a log line.

## Conventions

- C11 only; no C++, Arduino, Brookesia, BLE, cJSON or `esp_lvgl_port`.
- `sdkconfig` is not committed; change `sdkconfig.defaults` instead.
- Serial port: env `PORT`, default is the first `/dev/cu.usbmodem*`. Device UI copy is English.
