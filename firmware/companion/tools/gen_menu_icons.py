#!/usr/bin/env python3
"""Generates components/ui/img_menu_icons.c: the menu wheel's nine icons as pre-rendered A8 (alpha-only) images.

    python3 tools/gen_menu_icons.py > components/ui/img_menu_icons.c

The geometry is the design's (ACTUAL AELYS Companion, "Меню · колесо приложений"): each wheel item is an
`<i class="icon-NAME">` at font-size 28 px. The classes come from assets/aelys-icons.css (a 24x24 SVG,
stroke 1.75, round caps and joins, plus a 14% fill layer), and the paths below are copied from there. `gamepad-2`
is not in that file (the design falls back to Lucide), so its path is Lucide's gamepad-2 drawn in the same stroke.
The design's size is the same 28 px for every item and for the selected one (that is marked by the ring), so there
is one size. No SVG renderer is installed, so the paths are flattened and rasterised here with 4x4 supersampling.
Pure standard library; the design files are not read.
"""
import math
import re

SIZE = 28   # px, the design's font-size
SW = 1.75   # stroke width in the 24-unit box
SS = 4      # supersampling per axis
FILL_A = 0.14

# (name, fill path or None, stroke path) in wheel order: items[] in scr_menu.c.
ICONS = [
    ("square-check", "M4 8h13v11H4Z",
     "M5 3.5h10.5L19 7v3M8 3.5V2m-3 0v5m14 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7m4 4h5m-5 4h2m2-1 3 3 7-9"),
    ("timer", "M12 7a7 7 0 0 1 7 7h-7Z",
     "M9 3h6m-3 0v3m7 0 2-2M5 10a8 8 0 1 1-1 7M2 12h6m-5 4h3M12 9v5l4 2"),
    ("alarm-clock", None,
     "M7 3 3 6m14-3 4 3M6 19l-2 2m14-2 2 2M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM12 9v4l2.5 2"),
    ("calendar", "M5 8h12a2 2 0 0 1 2 2v2H5Z",
     "M4 7h13a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Zm4-4v6m7-6v6M4 12h16m-12 4h2m4 0h2M4 7l2-3h10"),
    ("bell", "M8 9a4 4 0 0 1 8 0v5l2 3H6l2-3Z",
     "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Zm4.5 3a3.5 3.5 0 0 0 5 0M12 2v3m6-1 2 2"),
    ("cloud-sun", "M7 19a3 3 0 1 1 0-6 5 5 0 0 1 9-1 4 4 0 1 1 2 7Z",
     "M7 2v2M2 7H4m.2-3.8 1.4 1.4M11 4.6l1.4-1.4M4 10.5a4 4 0 1 1 6.6-4.2"
     "M7 20a4 4 0 0 1-1-7.9 5.5 5.5 0 0 1 10.6-.6A4.4 4.4 0 1 1 18 21H7"),
    ("mic", "M10 6a2 2 0 0 1 4 0v5a2 2 0 0 1-4 0Z",
     "M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0V6ZM5 11a7 7 0 0 0 14 0M12 18v3m-3.5 0h7M15 7.5h2"),
    ("gamepad-2", None,
     "M6 11h4M8 9v4M15 12h.01M18 10h.01"
     "M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3"
     "c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3"
     "c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"),
    ("settings", None,
     "M5 3v18m14-18v18M12 3v18M3 7h4v4H3V7Zm7 7h4v4h-4v-4Zm7-9h4v4h-4V5Z"),
]


def arc(p0, rx, ry, phi, fa, fs, p1, k=24):
    """SVG endpoint arc -> points (W3C implementation notes F.6.5)."""
    (x1, y1), (x2, y2) = p0, p1
    if rx == 0 or ry == 0 or p0 == p1:
        return [p1]
    rx, ry, ph = abs(rx), abs(ry), math.radians(phi)
    c, s = math.cos(ph), math.sin(ph)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = c * dx + s * dy, -s * dx + c * dy
    lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
    den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    co = math.sqrt(max(0, num / den)) * (-1 if fa == fs else 1)
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx, cy = c * cxp - s * cyp + (x1 + x2) / 2, s * cxp + c * cyp + (y1 + y2) / 2

    def ang(ux, uy, vx, vy):
        return math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)

    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not fs and dt > 0:
        dt -= 2 * math.pi
    elif fs and dt < 0:
        dt += 2 * math.pi
    out = []
    for i in range(1, k + 1):
        t = t1 + dt * i / k
        ex, ey = rx * math.cos(t), ry * math.sin(t)
        out.append((c * ex - s * ey + cx, s * ex + c * ey + cy))
    return out


def cubic(p0, p1, p2, p3, k=16):
    return [tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d
                  for a, b, c, d in zip(p0, p1, p2, p3)) for t in (i / k for i in range(1, k + 1))]


def parse(d):
    """Path data -> list of (points, closed). Handles M L H V C A Z, absolute and relative."""
    toks = re.findall(r"[MmLlHhVvCcAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?", d)
    subs, pts, i = [], [], 0
    cur = start = (0.0, 0.0)
    cmd = ""
    arity = dict(M=2, L=2, H=1, V=1, C=6, A=7, Z=0)

    def num():
        nonlocal i
        i += 1
        return float(toks[i - 1])

    def flag():  # arc flags may be glued to the next number ("01-2"): split one digit off
        nonlocal i
        t = toks[i]
        if len(t) > 1 and t[0] in "01" and not t.startswith(("0.", "1.")):
            toks[i] = t[1:]
            return int(t[0])
        i += 1
        return int(float(t))

    while i < len(toks):
        if toks[i].isalpha():
            cmd = toks[i]
            i += 1
            if cmd in "Zz":
                if pts:
                    subs.append((pts, True))
                pts, cur = [], start
                continue
        elif cmd in "Mm":  # implicit lineto after a moveto
            cmd = "L" if cmd == "M" else "l"
        up, rel = cmd.upper(), cmd.islower()
        ox, oy = cur if rel else (0, 0)
        if up == "M":
            if pts:
                subs.append((pts, False))
            cur = start = (num() + ox, num() + oy)
            pts = [cur]
        elif up == "L":
            cur = (num() + ox, num() + oy)
            pts.append(cur)
        elif up == "H":
            cur = (num() + ox, cur[1])
            pts.append(cur)
        elif up == "V":
            cur = (cur[0], num() + oy)
            pts.append(cur)
        elif up == "C":
            c1 = (num() + ox, num() + oy)
            c2 = (num() + ox, num() + oy)
            e = (num() + ox, num() + oy)
            pts += cubic(cur, c1, c2, e)
            cur = e
        elif up == "A":
            rx, ry, phi = num(), num(), num()
            fa, fs = flag(), flag()
            e = (num() + ox, num() + oy)
            pts += arc(cur, rx, ry, phi, fa, fs, e)
            cur = e
        else:
            raise ValueError(cmd)
    if pts:
        subs.append((pts, False))
    return subs


def inside(subs, x, y):
    c = False
    for pts, _ in subs:  # every sub-path is closed for fill
        j = len(pts) - 1
        for k in range(len(pts)):
            (xi, yi), (xj, yj) = pts[k], pts[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                c = not c
            j = k
    return c


def seg_dist2(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0 if l2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
    qx, qy = ax + t * dx - px, ay + t * dy - py
    return qx * qx + qy * qy


def render(fill_d, stroke_d, n):
    k = n / 24
    scale = lambda subs: [([(x * k, y * k) for x, y in p], cl) for p, cl in subs]
    fill = scale(parse(fill_d)) if fill_d else []
    segs = []
    for pts, closed in scale(parse(stroke_d)):
        segs += list(zip(pts, pts[1:] + ([pts[0]] if closed else [])))
        if len(pts) == 1:
            segs.append((pts[0], pts[0]))  # a dot (zero-length segment with round caps)
    hw2 = (SW * k / 2) ** 2
    out = []
    for py in range(n):
        for px in range(n):
            near = [s for s in segs if min(s[0][0], s[1][0]) - SW * k <= px + 1 and max(s[0][0], s[1][0]) + SW * k >= px
                    and min(s[0][1], s[1][1]) - SW * k <= py + 1 and max(s[0][1], s[1][1]) + SW * k >= py]
            st = fl = 0
            for sy in range(SS):
                for sx in range(SS):
                    x, y = px + (sx + .5) / SS, py + (sy + .5) / SS
                    if any(seg_dist2(x, y, a, b) <= hw2 for a, b in near):
                        st += 1
                    elif fill and inside(fill, x, y):
                        fl += 1
            s, f = st / SS ** 2, fl / SS ** 2 * FILL_A
            out.append(round(255 * (1 - (1 - s) * (1 - f))))
    return out


def main():
    print("""/* Generated by tools/gen_menu_icons.py: do not edit. The menu wheel's icons as A8 images, in the order of
 * items[] in scr_menu.c, drawn at the design's 28 px and recoloured with the module colour. */
#include "ui_menu_icons.h"

#define IMG_A8(w_, h_, d_) { .header = { .magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_A8, \\
    .w = (w_), .h = (h_), .stride = (w_) }, .data_size = (w_) * (h_), .data = (d_) }
""")
    for name, f, s in ICONS:
        v = name.replace("-", "_")
        print(f"static const uint8_t icon_{v}[] = {{")
        a = render(f, s, SIZE)
        for r in range(SIZE):
            print(",".join(map(str, a[r * SIZE:(r + 1) * SIZE])) + ",")
        print("};")
    print("\nconst lv_image_dsc_t menu_icon[MENU_ICON_COUNT] = {")
    for name, _, _ in ICONS:
        print(f"    IMG_A8({SIZE}, {SIZE}, icon_{name.replace('-', '_')}),  /* {name} */")
    print("};")


if __name__ == "__main__":
    main()
