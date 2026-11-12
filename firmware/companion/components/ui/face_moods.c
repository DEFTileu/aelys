/* Mood table: ported 1:1 from MOODS in the design's CompanionFace.dc.html (scale 1 = 280x160). */
#include "ui_face_priv.h"

/* w, h, dx, dy, r_pct, lid_pct, tilt, smile, hollow */
#define EYE(...) { __VA_ARGS__ }
#define BOTH(...) .eye = { EYE(__VA_ARGS__), EYE(__VA_ARGS__) }

static const face_mood_t MOODS[MOOD_COUNT] = {
    [MOOD_CALM]      = { BOTH(70, 104, 0, 0, 46, 0, 0, false, false), .blink = true },
    [MOOD_HAPPY]     = { BOTH(78, 98, 0, 0, 50, 0, 0, true, false), .blink = true },
    [MOOD_PROUD]     = { BOTH(80, 96, 0, 0, 50, 0, 0, true, false), .blink = true, .sparkle = true },
    [MOOD_FOCUSED]   = { BOTH(84, 40, 0, 0, 40, 0, 0, false, false), .blink = true },
    [MOOD_WORRIED]   = { BOTH(64, 102, 0, 0, 46, 24, -16, false, false), .blink = true, .sweat = true },
    [MOOD_SAD]       = { BOTH(64, 86, 0, 10, 46, 32, -18, false, false), .blink = true },
    [MOOD_SURPRISED] = { BOTH(86, 124, 0, 0, 50, 0, 0, false, false), .blink = true, .glyph = '!' },
    [MOOD_CURIOUS]   = { .eye = { EYE(70, 104, 14, 0, 46, 0, 0, false, false),
                                  EYE(70, 82, 14, 0, 46, 0, 0, false, false) },
                         .blink = true, .glyph = '?' },
    [MOOD_SLEEPY]    = { BOTH(76, 100, 0, 0, 46, 58, 0, false, false), .blink = true },
    [MOOD_SLEEPING]  = { BOTH(84, 12, 0, 12, 50, 0, 0, false, false), .zz = true },
    [MOOD_DIZZY]     = { BOTH(70, 70, 0, 0, 50, 0, 0, false, true) },
    [MOOD_ANNOYED]   = { BOTH(80, 100, 0, 0, 40, 46, 9, false, false), .blink = true },
    [MOOD_LOVE]      = { BOTH(72, 104, 0, 0, 50, 0, 0, false, false), .blink = true, .cheeks = true },
    [MOOD_OFFLINE]   = { BOTH(44, 44, 0, -6, 50, 0, 0, false, false), .dots = true },
};

static const char *const NAMES[MOOD_COUNT] = {
    "calm", "happy", "proud", "focused", "worried", "sad", "surprised",
    "curious", "sleepy", "sleeping", "dizzy", "annoyed", "love", "offline",
};

const face_mood_t *face_mood_def(mood_t m)
{
    return (unsigned)m < MOOD_COUNT ? &MOODS[m] : NULL;
}

const char *mood_name(mood_t m)
{
    return (unsigned)m < MOOD_COUNT ? NAMES[m] : "?";
}

static int32_t px(int32_t v, int32_t s100) { return (v * s100 + (v < 0 ? -50 : 50)) / 100; }

face_rect_t face_eye_rect(const face_eye_t *e, int side, int32_t s100, int32_t blink_x1000)
{
    int32_t cx = 140 + (side ? 66 : -66) + e->dx, cy = 80 + e->dy;
    int32_t h2 = e->h * blink_x1000; /* height in x1000 units */
    face_rect_t r;
    r.w = px(e->w, s100);
    r.h = (h2 * s100 + 50000) / 100000;
    if (r.h < 1) r.h = 1;
    r.x = px(cx * 2 - e->w, s100) / 2; /* rounded to the same px as the browser's left = cx - w/2 */
    r.cx = px(cx, s100);
    r.cy = px(cy, s100);
    r.y = r.cy - r.h / 2;
    return r;
}

/* CSS: @keyframes cfBlink 0/92/100 % = 1, 95 % = .08, ease-in-out per segment, 5.2 s cycle. */
int32_t face_blink_x1000(uint32_t t_ms)
{
    int32_t p = (int32_t)((t_ms % 5200) * 1000 / 5200); /* permille of the cycle */
    int64_t u;                                          /* progress through the active segment */
    if (p < 920) return 1000;
    if (p < 950) {
        u = (p - 920) * 1000 / 30;
        return (int32_t)(1000 - (920 * (3 * u * u - 2 * u * u * u / 1000) / 1000) / 1000);
    }
    u = (p - 950) * 1000 / 50;
    return (int32_t)(80 + (920 * (3 * u * u - 2 * u * u * u / 1000) / 1000) / 1000);
}
