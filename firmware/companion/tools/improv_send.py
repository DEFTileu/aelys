#!/usr/bin/env python3
"""Send Wi-Fi settings to the board over Improv Serial and print its replies in words.

The password is asked with getpass: never an argument, never printed. Port: $PORT, default the
first /dev/cu.usbmodem*. --state only asks the board for its current state (no password).
Exit codes: 0 provisioned / state reply, 1 board answered with an error, 2 board not found.
"""
import argparse, getpass, glob, os, sys, time

import serial  # pyserial, from the IDF Python env

STATES = {0x02: "ready (authorized)", 0x03: "provisioning (connecting)", 0x04: "provisioned (connected)"}
ERRORS = {0x00: "no error", 0x01: "invalid RPC", 0x02: "unknown RPC", 0x03: "unable to connect", 0xFF: "unknown error"}


def frame(ptype, data):
    b = b"IMPROV" + bytes([1, ptype, len(data)]) + data
    return b + bytes([sum(b) & 0xFF])


def rpc(cmd, payload=b""):
    return frame(0x03, bytes([cmd, len(payload)]) + payload)


def wifi_rpc(ssid, password):
    s, p = ssid.encode(), password.encode()
    if not 0 < len(s) <= 32 or len(p) > 64:
        sys.exit("SSID must be 1..32 bytes and the password at most 64 bytes")
    return rpc(0x01, bytes([len(s)]) + s + bytes([len(p)]) + p)


def parse(buf):
    """Yield (type, data) for every complete valid frame in buf; leftover bytes are dropped."""
    i = 0
    while True:
        i = buf.find(b"IMPROV", i)
        if i < 0 or len(buf) < i + 9:
            return
        n = buf[i + 8]
        end = i + 9 + n
        if len(buf) < end + 1:
            return
        if buf[i + 6] == 1 and sum(buf[i:end]) & 0xFF == buf[end]:
            yield buf[i + 7], bytes(buf[i + 9:end])
            i = end + 1
        else:
            i += 1


def describe(ptype, data):
    if ptype == 0x01:
        return f"state: {STATES.get(data[0], hex(data[0]))}"
    if ptype == 0x02:
        return f"error: {ERRORS.get(data[0], hex(data[0]))}"
    if ptype == 0x04 and len(data) >= 2:
        strs, i = [], 2
        while i < len(data):
            strs.append(data[i + 1:i + 1 + data[i]].decode("utf-8", "replace"))
            i += 1 + data[i]
        return f"result for command {data[0]}: {strs if strs else 'ok (no strings)'}"
    return f"packet type {ptype}: {data.hex()}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ssid", help="network name; the password is asked interactively")
    ap.add_argument("--state", action="store_true", help="only request the current state")
    ap.add_argument("--info", action="store_true", help="only request the device information")
    ap.add_argument("--timeout", type=float, default=25, help="seconds to wait for the final reply")
    args = ap.parse_args()
    if not (args.ssid or args.state or args.info):
        ap.error("give --ssid NAME (or --state / --info)")

    found = sorted(glob.glob("/dev/cu.usbmodem*"))
    port = os.environ.get("PORT") or (found[0] if found else "<none>")
    if not os.path.exists(port):
        print(f"board not found on {port}", file=sys.stderr)
        return 2
    if args.ssid:
        pkt = wifi_rpc(args.ssid, getpass.getpass(f"Wi-Fi password for '{args.ssid}': "))
        final = 0x04  # the RPC result; a real error ends it earlier
    else:
        pkt = rpc(0x02 if args.state else 0x03)
        final = 0x04 if args.info else 0x01
    try:
        s = serial.Serial()
        s.port, s.baudrate, s.timeout = port, 115200, 0.2
        s.open()
        s.rts = False  # RTS first, then DTR: the other order pulses a chip reset (only --reset should)
        s.dtr = False
    except serial.SerialException as e:
        print(f"board not found on {port} ({e})", file=sys.stderr)
        return 2
    rc, buf, seen = 1, bytearray(), 0
    with s:
        s.reset_input_buffer()
        s.write(pkt)
        end = time.time() + args.timeout
        while time.time() < end:
            buf += s.read(4096)
            for ptype, data in list(parse(buf))[seen:]:
                seen += 1
                print(describe(ptype, data), flush=True)
                if ptype == 0x02 and data[0] != 0:  # a real error ends it
                    rc, end = 1, time.time() + 0.3
                elif ptype == final:
                    rc, end = 0, time.time() + 0.5  # let a trailing frame arrive
    return rc


if __name__ == "__main__":
    sys.exit(main())
