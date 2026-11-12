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
