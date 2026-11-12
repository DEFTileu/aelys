#!/usr/bin/env python3
"""Print the board's serial output for N seconds. PORT env overrides the default port."""
import argparse, glob, os, sys, time

import serial  # pyserial, from the IDF Python env


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=15)
    ap.add_argument("--reset", action="store_true", help="reset the chip via RTS first")
    args = ap.parse_args()

    found = sorted(glob.glob("/dev/cu.usbmodem*"))
    port = os.environ.get("PORT") or (found[0] if found else "<none>")
    if not os.path.exists(port):
        print(f"board not found on {port}", file=sys.stderr)
        return 2
    try:
        s = serial.Serial()
        s.port, s.baudrate, s.timeout = port, 115200, 0.2
        s.open()
        s.rts = False  # RTS first, then DTR: the other order pulses a chip reset (only --reset should)
        s.dtr = False
    except serial.SerialException as e:
        print(f"board not found on {port} ({e})", file=sys.stderr)
        return 2
    with s:
        if args.reset:
            # USB-Serial/JTAG: RTS drives EN; DTR low keeps the chip out of download mode.
            s.dtr = False
            s.rts = True
            time.sleep(0.1)
            s.rts = False
        end = time.time() + args.seconds
        while time.time() < end:
            data = s.read(4096)
            if data:
                sys.stdout.write(data.decode("utf-8", "replace"))
                sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
