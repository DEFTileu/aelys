#!/usr/bin/env python3
"""Pair the board over USB with the Improv vendor RPCs (0xA0..0xA3) and print the replies in words.

  improv_pair.py --secret-gen            PAIR_BEGIN (https://example.invalid/api/v1), print the public key,
                                         PAIR_CODE with a fixed UUID, print the 6-digit SAS this tool computes
                                         (compare it with the digits on the board's screen), PAIR_STATUS
  improv_pair.py --commit <device_id>    PAIR_COMMIT, then PAIR_STATUS (board shows "Paired")
  improv_pair.py --status                PAIR_STATUS only

The pairing secret is random, lives only in this process and is never printed. --commit works only in a
pairing whose code was requested (BEGIN and CODE), so it is normally combined with --secret-gen. Port: $PORT, default the first /dev/cu.usbmodem*.
Run with the repo venv (needs pyserial and the backend deps): .venv/bin/python firmware/companion/tools/improv_pair.py
Exit codes: 0 ok, 1 board answered with an error or not at all, 2 board not found.
"""
import argparse, base64, glob, os, secrets, sys, time
from pathlib import Path

import serial  # pyserial

sys.path.insert(0, str(Path(__file__).resolve().parent))
from improv_send import parse, rpc  # noqa: E402  (framing helpers shared with the Wi-Fi tool)

REPO = Path(__file__).resolve().parents[3]
# The backend settings object demands a secret at import time; this is a harmless dummy, never a real key.
os.environ.setdefault("AELYS_SECRET_KEY", "companion-vectors-dummy-not-a-secret-0000")
sys.path.insert(0, str(REPO / "backend"))
from app.core.device_auth import sas_code  # noqa: E402

BEGIN, CODE, COMMIT, STATUS = 0xA0, 0xA1, 0xA2, 0xA3
API_URL = "https://example.invalid/api/v1"
PAIRING_ID = "3f6c1a52-8d0e-4b7a-9c14-5e2d7a9b0c36"
ERRORS = {0x01: "bad arguments", 0x02: "unknown RPC", 0x80: "lost mode is on (pairing refused)",
          0x81: "no pending pairing", 0xFF: "unknown error"}


def strings(data):
    out, i = [], 2
    while i < len(data):
        out.append(data[i + 1:i + 1 + data[i]].decode("utf-8", "replace"))
        i += 1 + data[i]
    return out


def call(s, cmd, args, timeout=5.0):
    """Send one RPC; return its result strings. Raises RuntimeError on a board error or no reply."""
    payload = b"".join(bytes([len(a)]) + a for a in (x.encode() for x in args))
    s.reset_input_buffer()
    s.write(rpc(cmd, payload))
    buf, end = bytearray(), time.time() + timeout
    while time.time() < end:
        buf += s.read(4096)
        for ptype, data in parse(buf):
            if ptype == 0x02 and data[0] != 0:
                raise RuntimeError(f"board error 0x{data[0]:02x}: {ERRORS.get(data[0], 'unknown')}")
            if ptype == 0x04 and data[0] == cmd:
                return strings(data)
    raise RuntimeError("no reply from the board")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--secret-gen", action="store_true", help="begin a pairing with a fresh random secret")
    ap.add_argument("--commit", metavar="DEVICE_ID", help="commit the pending pairing under this device id")
    ap.add_argument("--status", action="store_true", help="only ask for the pairing status")
    args = ap.parse_args()
    if not (args.secret_gen or args.commit or args.status):
        ap.error("give --secret-gen, --commit DEVICE_ID or --status")

    found = sorted(glob.glob("/dev/cu.usbmodem*"))
    port = os.environ.get("PORT") or (found[0] if found else "<none>")
    try:
        s = serial.Serial()
        s.port, s.baudrate, s.timeout = port, 115200, 0.2
        s.open()
        s.rts = False  # RTS first, then DTR: the other order pulses a chip reset
        s.dtr = False
    except serial.SerialException as e:
        print(f"board not found on {port} ({e})", file=sys.stderr)
        return 2
    try:
        with s:
            if args.secret_gen:
                secret = secrets.token_urlsafe(32)  # 43 chars, within the board's 32..128
                pub = call(s, BEGIN, [secret, API_URL])[0]
                print(f"public key: {pub}")
                call(s, CODE, [PAIRING_ID])
                print(f"code on the board's screen must be: {sas_code(secret, PAIRING_ID, pub)}")
                del secret
            if args.commit:
                call(s, COMMIT, [args.commit])
                print(f"committed as {args.commit}")
            print("status:", call(s, STATUS, []))
    except RuntimeError as e:
        print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
