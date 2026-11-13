#!/usr/bin/env python3
"""Generates components/ui/img_fx.c: the face's small shapes as pre-rendered A8 (alpha-only) images.

    python3 tools/gen_face_fx.py > components/ui/img_fx.c

Shapes come from the design (ACTUAL AELYS Companion, CompanionFace): the 4-point star
(clip-path polygon, eye highlight and sparkles), the heart (clip-path path), the water drop
(16 px box, border-radius 0 50% 50% 50%, rotated 45 deg) and a bold "z". Each is rendered once
per pixel size with 8x8 supersampling; eye highlights also have pre-rendered
heights for blinks. The face selects a size and recolours it without a runtime
image transform. Pure standard library.
"""
import math

SS = 8  # supersampling per axis


def inside(poly, x, y):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def render(w, h, covered):
    """covered(x, y) in pixel units, origin top-left; returns w*h alpha bytes."""
    out = []
    for py in range(h):
        for px in range(w):
            n = sum(covered(px + (sx + .5) / SS, py + (sy + .5) / SS)
                    for sy in range(SS) for sx in range(SS))
            out.append(round(255 * n / (SS * SS)))
    return out


def star(n):
    pts = [(50, 0), (61, 39), (100, 50), (61, 61), (50, 100), (39, 61), (0, 50), (39, 39)]
    poly = [(x * n / 100, y * n / 100) for x, y in pts]
    return n, n, render(n, n, lambda x, y: inside(poly, x, y))


def squashed_star(w, h):
    pts = [(50, 0), (61, 39), (100, 50), (61, 61), (50, 100), (39, 61), (0, 50), (39, 39)]
    poly = [(x * w / 100, y * h / 100) for x, y in pts]
    return render(w, h, lambda x, y: inside(poly, x, y))


def emit_squashed_stars():
    rows, starts, off = [], [], 0
    print("static const uint8_t star_squashed_d[] = {")
    for w in range(5, 27):
        starts.append(len(rows))
        for h in range(1, (112 * w + 99) // 100 + 1):
            if h == w:
                continue
            a = squashed_star(w, h)
            print(f"/* star {w}x{h} */")
            print(",".join(map(str, a)) + ",")
            rows.append((w, h, off))
            off += w * h
    print("};")
    print("static const lv_image_dsc_t star_squashed_i[] = {")
    for w, h, o in rows:
        print(f"    IMG_A8({w}, {h}, star_squashed_d + {o}),")
    print("};")
    print("static const uint16_t star_squashed_start[] = { " + ", ".join(map(str, starts)) + " };")
    print('''const lv_image_dsc_t *face_img_star_squashed(int32_t width_key, int32_t openness_permille)
{
    int32_t w = width_key < 5 ? 5 : (width_key > 26 ? 26 : width_key);
    int32_t max_h = (112 * w + 99) / 100;
    int32_t h = openness_permille <= 0 ? 1 :
        (openness_permille >= 2000 ? max_h : (w * openness_permille + 500) / 1000);
    if (h < 1) h = 1;
    if (h > max_h) h = max_h;
    if (h == w) return face_img_star(w);
    return &star_squashed_i[star_squashed_start[w - 5] + h - 1 - (h > w)];
}''')


def bezier(p0, p1, p2, p3, k=12):
    return [tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d
                  for a, b, c, d in zip(p0, p1, p2, p3)) for t in (i / k for i in range(1, k + 1))]


def heart(w):
    h = round(w * 22 / 24)
    pts = [(12, 21), (3.5, 12.8)]
    pts += bezier((3.5, 12.8), (-.5, 9), (1.8, 2), (7, 2))
    pts += bezier((7, 2), (9.4, 2), (11, 3.4), (12, 5))
    pts += bezier((12, 5), (13, 3.4), (14.6, 2), (17, 2))
    pts += bezier((17, 2), (22.2, 2), (24.5, 9), (20.5, 12.8))
    poly = [(x * w / 24, y * h / 22) for x, y in pts]
    return w, h, render(w, h, lambda x, y: inside(poly, x, y))


def drop(n):
    """n x n box, only the top-left corner square, rotated 45 deg cw about the box centre.
    Image: n wide, ceil(1.2071 n) tall; the centre of the unrotated box is at (n/2, 0.7071 n)."""
    h = math.ceil(n * (0.5 + math.sqrt(.5)))
    cx, cy = n / 2, n * math.sqrt(.5)
    s = math.sqrt(.5)

    def covered(x, y):
        dx, dy = x - cx, y - cy
        ux, uy = (dx * s + dy * s), (-dx * s + dy * s)  # undo the 45 deg rotation
        return ux * ux + uy * uy <= (n / 2) ** 2 or (-n / 2 <= ux <= 0 and -n / 2 <= uy <= 0)

    return n, h, render(n, h, covered)


def zed(h):
    w = round(h * .93)
    t, dg = .22, .38 * .93
    pts = [(0, 0), (.93, 0), (.93, t), (dg, 1 - t), (.93, 1 - t), (.93, 1), (0, 1), (0, 1 - t),
           (.93 - dg, t), (0, t)]
    poly = [(x * w / .93, y * h) for x, y in pts]
    return w, h, render(w, h, lambda x, y: inside(poly, x, y))


def emit(name, fn, sizes, make):
    print(f"static const uint8_t {name}_d[] = {{")
    rows, off = [], 0
    for s in sizes:
        w, h, a = make(s)
        print(f"/* {name} {s}: {w}x{h} */")
        print(",".join(map(str, a)) + ",")
        rows.append((s, w, h, off))
        off += w * h
    print("};")
    print(f"static const lv_image_dsc_t {name}_i[] = {{")
    for s, w, h, o in rows:
        print(f"    IMG_A8({w}, {h}, {name}_d + {o}),  /* {s} */")
    print("};")
    print(f"static const uint8_t {name}_k[] = {{ " + ", ".join(str(s) for s, *_ in rows) + " };")
    print(f"const lv_image_dsc_t *{fn}(int32_t key) {{ return img_pick({name}_i, {name}_k, {len(rows)}, key); }}")


print("""/* Generated by tools/gen_face_fx.py: do not edit. A8 images of the face's star, heart, drop and "z",
 * with pre-rendered eye-highlight heights; no image is scaled at run time. */
#include "ui_face_priv.h"

#define IMG_A8(w_, h_, d_) { .header = { .magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_A8, \\
    .w = (w_), .h = (h_), .stride = (w_) }, .data_size = (w_) * (h_), .data = (d_) }

/* the image whose key is nearest to `key` */
static const lv_image_dsc_t *img_pick(const lv_image_dsc_t *img, const uint8_t *k, int n, int32_t key)
{
    int best = 0;
    for (int i = 1; i < n; i++) {
        int32_t a = key - k[i], b = key - k[best];
        if ((a < 0 ? -a : a) < (b < 0 ? -b : b)) best = i;
    }
    return &img[best];
}
""")
emit("star", "face_img_star", range(5, 27), star)
print()
emit_squashed_stars()
print()
emit("heart", "face_img_heart", range(6, 25, 2), heart)
print()
emit("drop", "face_img_drop", range(4, 17, 2), drop)
print()
emit("zed", "face_img_z", range(4, 19), zed)
