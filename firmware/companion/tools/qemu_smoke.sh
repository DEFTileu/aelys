#!/usr/bin/env bash
# Boot the companion image in QEMU (esp32s3) and check the log. Needs an exported ESP-IDF
# (. ~/esp/esp-idf/export.sh) and qemu-xtensa (idf_tools.py install qemu-xtensa).
# The panel and touch controller do not exist in QEMU, so "board_init failed ... (idle)" is an
# accepted outcome: the pass criterion is only that the firmware boots and prints its banner.
set -euo pipefail
cd "$(dirname "$0")/.."

TMO=$(command -v timeout || command -v gtimeout) || { echo "need timeout (macOS: brew install coreutils)"; exit 2; }
IDF=(idf.py -B build-qemu -D SDKCONFIG=build-qemu/sdkconfig -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.qemu")
LOG=build-qemu/qemu.log

"${IDF[@]}" build
# idf.py qemu runs QEMU in the foreground on stdio; stop it after 20 s. QEMU is a child of idf.py,
# so kill it by its flash image as well.
"$TMO" 20 "${IDF[@]}" qemu </dev/null >"$LOG" 2>&1 || true
pkill -9 -f build-qemu/qemu_flash.bin || true

tail -n 40 "$LOG"
grep -q 'Aelys companion fw' "$LOG" || { echo "FAIL: no boot banner"; exit 1; }
if grep -E 'Guru Meditation|abort\(\)|rst:0xc' "$LOG"; then echo "FAIL: crash in log"; exit 1; fi
echo "PASS: QEMU boot smoke"
