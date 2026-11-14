/* Mood table and animation curves, ported from the design's face CSS (ACTUAL AELYS Companion, CompanionFace):
 * the .e eye boxes and lids per mood, the `.ey` group keyframes (look, hop, sway, breathe, jit, sink, pop, tilt,
 * wobble, huff) and the effect loops (twinkle, drip, zz, burst, d3). Integer math only. */
#include "ui_face_priv.h"

/* x, y, w, h, radius, star x, star y, star edge [, lid cut y (tenths of px), lid slope (permille)] */
#define E(...) { __VA_ARGS__, 0, 0 }
#define EL(...) { __VA_ARGS__ }
#define STD 38, 14, 20 /* the highlight: left 38, top 14, 20 px */
#define NOSTAR 0, 0, 0
/* Rotated lids: the black box (118 wide, rotated 16 / 18 deg about its middle) cuts the eye along its bottom
 * edge. At the eye's middle that edge is lid_bottom_from_centre / cos(angle) below the box's centre:
 * worried -7 + 31/cos16 = 25.3, sad -4 + 26/cos16 = 23.1, annoyed 26/cos18 = 27.3; slope = tan(angle). */

static const face_mood_t MOODS[MOOD_COUNT] = {
    [MOOD_CALM] = { .eye = { E(58, 35, 70, 100, 35, STD), E(172, 35, 70, 100, 35, STD) },
                    .kind = EYE_PILL, .motion = MOT_LOOK, .blink_ms = 5000 },
    [MOOD_HAPPY] = { .eye = { E(58, 35, 70, 100, 35, STD), E(172, 35, 70, 100, 35, STD) },
                     .kind = EYE_PILL, .lid = LID_DOME, .motion = MOT_HOP },
    [MOOD_PROUD] = { .eye = { E(58, 35, 70, 100, 35, STD), E(172, 35, 70, 100, 35, STD) },
                     .kind = EYE_PILL, .lid = LID_DOME, .motion = MOT_HOP_SLOW,
                     .n_spark = 3, .spark = { { 14, 18, 26, 0 }, { 262, 4, 26, 600 }, { 268, 118, 20, 1200 } } },
    [MOOD_FOCUSED] = { .eye = { E(58, 63, 70, 44, 22, 40, 8, 14), E(172, 63, 70, 44, 22, 40, 8, 14) },
                       .kind = EYE_PILL, .motion = MOT_BREATHE, .blink_ms = 8000 },
    [MOOD_WORRIED] = { .eye = { EL(58, 42, 70, 92, 35, STD, 253, -287), EL(172, 42, 70, 92, 35, STD, 253, 287) },
                       .kind = EYE_PILL, .lid = LID_SLANT, .motion = MOT_JIT, .blink_ms = 5000,
                       .drop = true, .drop_at = { 256, 26, 16, 0 }, .drop_ms = 2400 },
    [MOOD_SAD] = { .eye = { EL(58, 56, 70, 80, 35, STD, 231, -287), EL(172, 56, 70, 80, 35, STD, 231, 287) },
                   .kind = EYE_PILL, .lid = LID_SLANT, .motion = MOT_SINK, .blink_ms = 6000,
                   .drop = true, .drop_at = { 84, 132, 16, 0 }, .drop_ms = 3200 },
    [MOOD_SURPRISED] = { .eye = { E(51, 30, 84, 110, 42, 46, 14, 20), E(165, 30, 84, 110, 42, 46, 14, 20) },
                         .kind = EYE_PILL, .motion = MOT_POP, .blink_ms = 5000,
                         .n_line = 3, .line = { { 252, 12, 40, 0 }, { 270, 42, 70, 0 }, { 230, 0, 12, 0 } } },
    [MOOD_CURIOUS] = { .eye = { E(58, 46, 70, 84, 35, STD), E(172, 26, 70, 112, 35, STD) },
                       .kind = EYE_PILL, .motion = MOT_TILT, .blink_ms = 5000 },
    /* the lid is 96 px tall and slides from -56 % to -30 % of that: its bottom edge goes 42.2 -> 67.2 px */
    [MOOD_SLEEPY] = { .eye = { EL(58, 42, 70, 96, 35, STD, 422, 0), EL(172, 42, 70, 96, 35, STD, 422, 0) },
                      .kind = EYE_PILL, .lid = LID_DROOP, .motion = MOT_SINK_SLOW },
    [MOOD_SLEEPING] = { .eye = { E(58, 76, 70, 28, 35, NOSTAR), E(172, 76, 70, 28, 35, NOSTAR) },
                        .kind = EYE_ARC, .border = 7, .color = 0x8F70F7, .motion = MOT_BREATHE,
                        .n_zz = 2, .zz = { { 238, 56, 30, 0 }, { 264, 28, 22, 1600 } } },
    [MOOD_DIZZY] = { .eye = { E(55, 47, 76, 76, 38, NOSTAR), E(169, 47, 76, 76, 38, NOSTAR) },
                     .kind = EYE_RING, .border = 12, .color = 0xA98CFB, .motion = MOT_WOBBLE },
    [MOOD_ANNOYED] = { .eye = { EL(58, 54, 70, 76, 35, STD, 273, 325), EL(172, 54, 70, 76, 35, STD, 273, -325) },
                       .kind = EYE_PILL, .lid = LID_SLANT, .motion = MOT_HUFF, .blink_ms = 6000 },
    [MOOD_LOVE] = { .eye = { E(58, 35, 70, 100, 35, STD), E(172, 35, 70, 100, 35, STD) },
                    .kind = EYE_PILL, .lid = LID_DOME, .motion = MOT_SWAY, .cheeks = true,
                    .n_heart = 2, .heart = { { 258, 20, 24, 0 }, { 16, 34, 24, 1400 } } },
    [MOOD_OFFLINE] = { .eye = { E(79, 66, 28, 28, 14, NOSTAR), E(193, 66, 28, 28, 14, NOSTAR) },
                       .kind = EYE_DOT, .color = 0x4A4554, .motion = MOT_NONE, .dots = true },
    /* Additional character states from the ACTUAL design. */
    [MOOD_ATTENTION] = { .eye = { E(58,31,70,108,35,30,12,20), E(172,31,70,108,35,30,12,20) },
        .kind = EYE_PILL, .motion = MOT_NONE, .blink_style = BLINK_DOUBLE, .blink_ms = 3000 },
    [MOOD_FLOW] = { .eye = { E(58,63,70,44,22,40,8,14), E(172,63,70,44,22,40,8,14) },
        .kind = EYE_PILL, .motion = MOT_BREATHE_SLOW, .blink_ms = 9000, .glow_width = 22 },
    [MOOD_ELATION] = { .eye = { E(58,35,70,100,35,STD), E(172,35,70,100,35,STD) },
        .kind = EYE_PILL, .lid = LID_DOME, .motion = MOT_PARTY, .confetti = true },
    [MOOD_RELIEF] = { .eye = { EL(58,45,70,90,35,STD,320,0), EL(172,45,70,90,35,STD,320,0) },
        .kind = EYE_PILL, .lid = LID_RELAX, .motion = MOT_SINK_RELIEF },
    [MOOD_PANIC] = { .eye = { E(63,26,60,118,30,28,12,20), E(177,26,60,118,30,28,12,20) },
        .kind = EYE_PILL, .motion = MOT_SHAKE },
    [MOOD_DISAPPOINTED] = { .eye = { EL(58,60,70,76,35,STD,300,0), EL(172,60,70,76,35,STD,300,0) },
        .kind = EYE_PILL, .lid = LID_SLANT, .motion = MOT_SINK_LETDOWN, .blink_ms = 7000 },
    [MOOD_ANTICIPATION] = { .eye = { E(58,35,70,100,35,42,10,20), E(172,35,70,100,35,42,10,20) },
        .kind = EYE_PILL, .motion = MOT_PEEK, .blink_ms = 5000 },
    [MOOD_THINKING] = { .eye = { E(58,30,70,90,35,36,6,20), E(172,30,70,90,35,36,6,20) },
        .kind = EYE_PILL, .motion = MOT_PONDER, .blink_ms = 5000 },
    [MOOD_FRIGHTENED] = { .eye = { E(70,62,46,46,23,22,6,12), E(184,62,46,46,23,22,6,12) },
        .kind = EYE_PILL, .motion = MOT_JUMP },
    [MOOD_TICKLED] = { .eye = { E(58,35,70,100,35,STD), E(172,35,70,100,35,STD) },
        .kind = EYE_PILL, .lid = LID_DOME, .motion = MOT_SHIVER,
        .n_spark = 2, .spark = { {24,20,16,0}, {258,16,16,500} } },
    [MOOD_BASHFUL] = { .eye = { EL(40,54,70,88,35,STD,264,0), EL(154,54,70,88,35,STD,264,0) },
        .kind = EYE_PILL, .lid = LID_SLANT, .motion = MOT_NONE, .cheeks = true },
    [MOOD_MISCHIEF] = { .eye = { EL(58,35,70,100,35,STD,240,-213), E(172,35,70,100,35,STD) },
        .kind = EYE_PILL, .lid = LID_SLANT, .motion = MOT_CHEEKY, .blink_style = BLINK_WINK, .blink_ms = 3000 },
    [MOOD_WAKING] = { .eye = { E(58,35,70,100,35,STD), E(172,35,70,100,35,STD) },
        .kind = EYE_PILL, .motion = MOT_NONE, .blink_style = BLINK_WAKE, .blink_ms = 3000 },
    [MOOD_BORED] = { .eye = { EL(58,35,70,100,35,STD,480,0), EL(172,35,70,100,35,STD,480,0) },
        .kind = EYE_PILL, .lid = LID_SLANT, .motion = MOT_DRIFT, .blink_ms = 5000 },
    [MOOD_MISSED] = { .eye = { EL(58,42,70,92,35,STD,180,-176), EL(172,42,70,92,35,STD,180,176) },
        .kind = EYE_PILL, .lid = LID_SLANT, .motion = MOT_SEARCH },
    [MOOD_EXHAUSTED] = { .eye = { EL(58,52,70,84,35,STD,320,0), EL(172,52,70,84,35,STD,320,0) },
        .kind = EYE_PILL, .lid = LID_SLANT, .motion = MOT_SINK, .blink_ms = 6000,
        .gradient_top = 0x8C869A, .gradient_bottom = 0x4A4554, .star_opacity = 128 },
    [MOOD_CHARGING] = { .eye = { EL(58,35,70,100,35,STD,340,0), EL(172,35,70,100,35,STD,340,0) },
        .kind = EYE_PILL, .lid = LID_SLANT, .motion = MOT_BREATHE },
    [MOOD_RECONNECTED] = { .eye = { E(58,35,70,100,35,STD), E(172,35,70,100,35,STD) },
        .kind = EYE_PILL, .motion = MOT_HOP_SLOW, .blink_style = BLINK_DOUBLE, .blink_ms = 1600 },
};

static const char *const NAMES[MOOD_COUNT] = {
    "calm", "happy", "proud", "focused", "worried", "sad", "surprised",
    "curious", "sleepy", "sleeping", "dizzy", "annoyed", "love", "offline",
    "attention", "flow", "elation", "relief", "panic", "disappointed", "anticipation", "thinking",
    "frightened", "tickled", "bashful", "mischief", "waking", "bored", "missed", "exhausted",
    "charging", "reconnected",
};

const face_mood_t *face_mood_def(mood_t m)
{
    return (unsigned)m < MOOD_COUNT ? &MOODS[m] : NULL;
}

const char *mood_name(mood_t m)
{
    return (unsigned)m < MOOD_COUNT ? NAMES[m] : "?";
}

mood_t mood_from_character(character_mood_t mood)
{
    static const mood_t map[CHAR_MOOD_COUNT] = {
        [CHAR_CALM] = MOOD_CALM, [CHAR_ATTENTION] = MOOD_ATTENTION,
        [CHAR_FOCUSED] = MOOD_FOCUSED, [CHAR_FLOW] = MOOD_FLOW,
        [CHAR_JOY] = MOOD_HAPPY, [CHAR_ELATION] = MOOD_ELATION,
        [CHAR_PRIDE] = MOOD_PROUD, [CHAR_RELIEF] = MOOD_RELIEF,
        [CHAR_ANXIETY] = MOOD_WORRIED, [CHAR_PANIC] = MOOD_PANIC,
        [CHAR_SAD] = MOOD_SAD, [CHAR_DISAPPOINTED] = MOOD_DISAPPOINTED,
        [CHAR_ANTICIPATION] = MOOD_ANTICIPATION, [CHAR_THINKING] = MOOD_THINKING,
        [CHAR_CURIOUS] = MOOD_CURIOUS, [CHAR_SURPRISED] = MOOD_SURPRISED,
        [CHAR_FRIGHTENED] = MOOD_FRIGHTENED, [CHAR_TICKLED] = MOOD_TICKLED,
        [CHAR_TENDER] = MOOD_LOVE, [CHAR_BASHFUL] = MOOD_BASHFUL,
        [CHAR_IRRITATED] = MOOD_ANNOYED, [CHAR_DIZZY] = MOOD_DIZZY,
        [CHAR_MISCHIEF] = MOOD_MISCHIEF, [CHAR_WAKING] = MOOD_WAKING,
        [CHAR_BORED] = MOOD_BORED, [CHAR_MISSED] = MOOD_MISSED,
        [CHAR_SLEEPY] = MOOD_SLEEPY, [CHAR_SLEEPING] = MOOD_SLEEPING,
        [CHAR_EXHAUSTED] = MOOD_EXHAUSTED, [CHAR_CHARGING] = MOOD_CHARGING,
        [CHAR_OFFLINE] = MOOD_OFFLINE, [CHAR_RECONNECTED] = MOOD_RECONNECTED,
    };
    return (unsigned)mood < CHAR_MOOD_COUNT ? map[mood] : MOOD_CALM;
}

/* Smoothstep and quadratic approximations remain in use for effects and
 * other animation styles. All take and give permille. */
static int32_t ease(int32_t u) { return u * u * (3000 - 2 * u) / 1000000; }
static int32_t ease_out(int32_t u) { return 1000 - (1000 - u) * (1000 - u) / 1000; }
static int32_t ease_in(int32_t u) { return u * u / 1000; }

/* CSS ease-in-out = cubic-bezier(.42,0,.58,1), sampled every 2%.
 * Linear interpolation stays within 1.1 permille at integer-permille inputs. */
static int32_t group_ease(int32_t u)
{
    static const uint16_t samples[] = {
        0,1,3,7,13,20,29,39,52,66,82,99,119,140,163,187,214,
        241,270,300,332,364,397,431,466,500,534,569,603,636,668,
        700,730,759,786,813,837,860,881,901,918,934,948,961,971,
        980,987,993,997,999,1000
    };
    if (u <= 0) return 0;
    if (u >= 1000) return 1000;
    unsigned i = (unsigned)u / 20u, remainder = (unsigned)u % 20u;
    return (samples[i] * (20u - remainder) + samples[i + 1] * remainder + 10u) / 20u;
}

/* ---- eye group (.ey) keyframes ---- */
typedef struct { int16_t t, tx, ty, rot, sc; } kf_t; /* t permille of the loop; px, px, deg, permille */
typedef struct { uint16_t period; uint8_t easing, n; kf_t k[9]; } motion_t; /* 0 ease-in-out, 1 out, 2 linear */
#define K(t, tx, ty, rot) { t, tx, ty, rot, 1000 }
#define KS(t, sc) { t, 0, 0, 0, sc }

static const motion_t MOTION[MOT_COUNT] = {
    [MOT_NONE] = { 0, false, 0, { { 0 } } },
    [MOT_LOOK] = { 9000, false, 8, { K(0, 0, 0, 0), K(280, 0, 0, 0), K(340, -14, 2, 0), K(500, -14, 2, 0),
                                     K(560, 12, -4, 0), K(720, 12, -4, 0), K(780, 0, 0, 0), K(1000, 0, 0, 0) } },
    [MOT_HOP] = { 1000, false, 3, { K(0, 0, 0, 0), K(500, 0, -10, 0), K(1000, 0, 0, 0) } },
    [MOT_HOP_SLOW] = { 1600, false, 3, { K(0, 0, 0, 0), K(500, 0, -10, 0), K(1000, 0, 0, 0) } },
    [MOT_SWAY] = { 3000, false, 3, { K(0, 0, 0, -4), K(500, 0, 0, 4), K(1000, 0, 0, -4) } },
    [MOT_BREATHE] = { 4000, false, 3, { KS(0, 1000), KS(500, 1050), KS(1000, 1000) } },
    [MOT_JIT] = { 1400, false, 4, { K(0, 0, 0, 0), K(250, -3, 0, 0), K(750, 3, 0, 0), K(1000, 0, 0, 0) } },
    [MOT_SINK] = { 4000, false, 3, { K(0, 0, 0, 0), K(500, 0, 6, 0), K(1000, 0, 0, 0) } },
    [MOT_SINK_SLOW] = { 4500, false, 3, { K(0, 0, 0, 0), K(500, 0, 6, 0), K(1000, 0, 0, 0) } },
    [MOT_POP] = { 2400, true, 6, { KS(0, 1000), KS(300, 1000), KS(400, 1160), KS(500, 1080), KS(850, 1080),
                                   KS(1000, 1000) } },
    [MOT_TILT] = { 4000, false, 6, { K(0, 0, 0, 0), K(300, -14, 0, -8), K(450, -14, 0, -8), K(650, 14, -4, 6),
                                     K(800, 14, -4, 6), K(1000, 0, 0, 0) } },
    [MOT_WOBBLE] = { 1600, false, 3, { K(0, 0, 0, -9), K(500, 0, 0, 9), K(1000, 0, 0, -9) } },
    [MOT_HUFF] = { 3000, false, 9, { K(0, 0, 0, 0), K(200, 0, 0, 0), K(300, 16, 0, 0), K(600, 16, 0, 0),
                                     K(640, 12, 0, 0), K(680, 18, 0, 0), K(720, 14, 0, 0), K(850, 0, 0, 0),
                                     K(1000, 0, 0, 0) } },
    [MOT_PARTY] = { 1200, 0, 4, { K(0,0,0,0), K(250,0,-14,-6), K(750,0,-14,6), K(1000,0,0,0) } },
    [MOT_SHAKE] = { 220, 2, 4, { K(0,0,0,0), K(250,-4,1,0), K(750,4,-1,0), K(1000,0,0,0) } },
    [MOT_PEEK] = { 2600, 0, 5, { K(0,0,0,0), K(400,0,0,0), K(550,14,-10,0), K(850,14,-10,0), K(1000,0,0,0) } },
    [MOT_PONDER] = { 3400, 0, 3, { K(0,-6,-8,0), K(500,8,-10,0), K(1000,-6,-8,0) } },
    [MOT_JUMP] = { 1800, 1, 5, { K(0,0,0,0), {80,0,-22,0,1100}, {200,0,0,0,960}, K(600,0,0,0), K(1000,0,0,0) } },
    [MOT_SHIVER] = { 200, 2, 3, { K(0,0,0,0), K(500,0,-3,0), K(1000,0,0,0) } },
    /* The design declares drift twice; the later global keyframes win. */
    [MOT_DRIFT] = { 7000, 0, 3, { K(0,-12,4,0), K(500,12,4,0), K(1000,-12,4,0) } },
    [MOT_SEARCH] = { 4400, 0, 6, { K(0,0,0,0), K(200,-24,0,0), K(350,-24,0,0), K(550,24,0,0), K(700,24,0,0), K(1000,0,0,0) } },
    [MOT_BREATHE_SLOW] = { 5000, 0, 3, { KS(0,1000), KS(500,1050), KS(1000,1000) } },
    [MOT_SINK_RELIEF] = { 3200, 0, 3, { K(0,0,0,0), K(500,0,6,0), K(1000,0,0,0) } },
    [MOT_SINK_LETDOWN] = { 5000, 0, 3, { K(0,0,0,0), K(500,0,6,0), K(1000,0,0,0) } },
    [MOT_CHEEKY] = { 3000, 0, 2, { K(0,0,0,-7), K(1000,0,0,-7) } },
};

uint32_t face_motion_period(face_motion_t m) { return (unsigned)m < MOT_COUNT ? MOTION[m].period : 0; }

face_group_t face_group_at(face_motion_t m, uint32_t t_ms)
{
    face_group_t g = { 0, 0, 0, 1000 };
    if ((unsigned)m >= MOT_COUNT || !MOTION[m].period) return g;
    const motion_t *mo = &MOTION[m];
    uint64_t p = (uint64_t)(t_ms % mo->period) * 1000u;
    int i = 0;
    while (i + 2 < mo->n && p > (uint64_t)mo->k[i + 1].t * mo->period) i++;
    const kf_t *a = &mo->k[i], *b = &mo->k[i + 1];
    int32_t u = (int32_t)((p - (uint64_t)a->t * mo->period) * 1000u /
                          ((uint64_t)(b->t - a->t) * mo->period));
    int32_t e = mo->easing == 2 ? u : mo->easing == 1 ? ease_out(u) : group_ease(u);
    g.tx = a->tx * 100 + (b->tx - a->tx) * e / 10;
    g.ty = a->ty * 100 + (b->ty - a->ty) * e / 10;
    g.rot = a->rot * 100 + (b->rot - a->rot) * e / 10;
    g.sc = a->sc + (b->sc - a->sc) * e / 1000;
    return g;
}

/* CSS ease = cubic-bezier(.25,.1,.25,1), sampled at 2% intervals.
 * Linear interpolation is within 1.3 permille of the ideal curve for each
 * integer-permille input; the table and arithmetic need no heap or float. */
static int32_t css_ease(int32_t u)
{
    static const uint16_t samples[] = {
        0,10,24,43,66,95,128,165,206,250,295,341,386,430,473,513,552,
        588,621,653,683,710,736,760,782,802,822,839,856,871,885,898,
        910,921,931,941,949,957,964,970,976,981,985,989,992,994,996,
        998,999,1000,1000
    };
    if (u <= 0) return 0;
    if (u >= 1000) return 1000;
    unsigned i = (unsigned)u / 20u, remainder = (unsigned)u % 20u;
    return (samples[i] * (20u - remainder) + samples[i + 1] * remainder + 10u) / 20u;
}

/* CSS blink uses ease independently between keyframes. */
int32_t face_blink_x1000(uint32_t period_ms, uint32_t t_ms)
{
    if (!period_ms) return 1000;
    uint64_t p = (uint64_t)(t_ms % period_ms) * 1000u;
    uint64_t start = (uint64_t)period_ms * 930u;
    uint64_t closed = (uint64_t)period_ms * 960u;
    if (p < start) return 1000;
    if (p < closed) {
        int32_t u = (int32_t)((p - start) * 1000u / ((uint64_t)period_ms * 30u));
        return 1000 - 920 * css_ease(u) / 1000;
    }
    int32_t u = (int32_t)((p - closed) * 1000u / ((uint64_t)period_ms * 40u));
    return 80 + 920 * css_ease(u) / 1000;
}

static int32_t interpolate(int32_t p, int32_t a, int32_t b, int32_t from, int32_t to, bool out)
{
    int32_t u = (p - a) * 1000 / (b - a);
    int32_t e = out ? ease_out(u) : ease(u);
    return from + (to - from) * e / 1000;
}

static int32_t interpolate_css_ease(uint64_t p, uint64_t a, uint64_t b, int32_t from, int32_t to)
{
    int32_t u = (int32_t)((p - a) * 1000u / (b - a));
    return from + (to - from) * css_ease(u) / 1000;
}

int32_t face_eye_openness(const face_mood_t *m, int side, uint32_t t_ms)
{
    if (!m || !m->blink_ms) return 1000;
    int32_t p = (int32_t)(t_ms % m->blink_ms * 1000 / m->blink_ms);
    if (m->blink_style == BLINK_DOUBLE) {
        uint64_t phase = (uint64_t)(t_ms % m->blink_ms) * 1000u;
        uint64_t period = m->blink_ms;
        if (phase < period * 700u) return 1000;
        if (phase < period * 730u)
            return interpolate_css_ease(phase, period * 700u, period * 730u, 1000, 80);
        if (phase < period * 780u)
            return interpolate_css_ease(phase, period * 730u, period * 780u, 80, 1000);
        if (phase < period * 810u)
            return interpolate_css_ease(phase, period * 780u, period * 810u, 1000, 80);
        return interpolate_css_ease(phase, period * 810u, period * 1000u, 80, 1000);
    }
    if (m->blink_style == BLINK_WINK) {
        /* The design overrides the right eye only; the left keeps its base blink. */
        if (!side) return face_blink_x1000(5000, t_ms);
        uint64_t phase = (uint64_t)(t_ms % m->blink_ms) * 1000u;
        uint64_t period = m->blink_ms;
        if (phase < period * 600u) return 1000;
        if (phase < period * 680u)
            return interpolate_css_ease(phase, period * 600u, period * 680u, 1000, 100);
        if (phase < period * 840u) return 100;
        return interpolate_css_ease(phase, period * 840u, period * 1000u, 100, 1000);
    }
    if (m->blink_style == BLINK_WAKE) {
        if (p < 350) return 100;
        if (p < 550) return interpolate(p,350,550,100,1120,true);
        if (p < 700) return interpolate(p,550,700,1120,1000,true);
        return 1000;
    }
    return face_blink_x1000(m->blink_ms, t_ms);
}

int32_t face_relax_lid_y100(uint32_t t_ms)
{
    int32_t phase = (int32_t)(t_ms % 3200u * 1000u / 3200u);
    int32_t progress = phase <= 500 ? phase * 2 : (1000 - phase) * 2;
    return 800 * ease(progress) / 1000;
}

face_confetti_state_t face_confetti_at(uint32_t t_ms, uint32_t delay_ms)
{
    /* Before CSS animation-delay elapses, the particle is at its base style. */
    if (t_ms < delay_ms) return (face_confetti_state_t){0, 0, 255};
    uint32_t phase = (t_ms - delay_ms) % 1800u;
    face_confetti_state_t state;
    state.dy100 = (int16_t)(-2000 + (int32_t)(phase * 14000u / 1800u));
    state.angle = (int16_t)(phase * 300u / 1800u);
    state.opacity = (uint8_t)(phase < 270u ? phase * 255u / 270u : (1800u - phase) * 255u / 1530u);
    return state;
}

/* ---- effect loops ---- */
static int32_t phase(uint32_t t_ms, uint32_t period, uint32_t delay) /* permille, delayed start */
{
    return (int32_t)((t_ms + period - delay % period) % period * 1000 / period);
}

/* @keyframes zz: opacity 0 -> 1 at 30 % -> 0; translate (0,10) -> (16,-34) over the whole loop */
face_fx_state_t face_fx_rise(uint32_t t_ms, uint32_t period_ms, uint32_t delay_ms)
{
    int32_t p = phase(t_ms, period_ms, delay_ms), e = ease(p);
    face_fx_state_t s;
    s.op = p < 300 ? 255 * ease(p * 1000 / 300) / 1000 : 255 - 255 * ease((p - 300) * 1000 / 700) / 1000;
    s.dx = 1600 * e / 1000;
    s.dy = 1000 - 4400 * e / 1000;
    s.k = 1000;
    return s;
}

/* @keyframes drip (ease-in): opacity 0 -> 1 at 25 % -> 0; translate (0,-4) -> (0,34) */
face_fx_state_t face_fx_drip(uint32_t t_ms, uint32_t period_ms)
{
    int32_t p = (int32_t)(t_ms % period_ms * 1000 / period_ms);
    face_fx_state_t s;
    s.op = p < 250 ? 255 * ease_in(p * 4) / 1000 : 255 - 255 * ease_in((p - 250) * 1000 / 750) / 1000;
    s.dx = 0;
    s.dy = -400 + 3800 * ease_in(p) / 1000;
    s.k = 1000;
    return s;
}

/* @keyframes tw 1.8 s: scale .2 -> 1 at 50 % -> .2, opacity the same (the 45 degree turn is left out) */
face_fx_state_t face_fx_twinkle(uint32_t t_ms, uint32_t delay_ms)
{
    int32_t p = phase(t_ms, 1800, delay_ms);
    int32_t e = ease(p < 500 ? p * 2 : (1000 - p) * 2);
    face_fx_state_t s = { 255 * e / 1000, 0, 0, 200 + 800 * e / 1000 };
    return s;
}

/* @keyframes burst 2.4 s: 0-30 % hidden and short (scale 1 .3), 42 % full, 80 % gone */
face_fx_state_t face_fx_burst(uint32_t t_ms)
{
    int32_t p = (int32_t)(t_ms % 2400 * 1000 / 2400);
    face_fx_state_t s = { 0, 0, 0, 1000 };
    if (p < 300) s.k = 300;
    else if (p < 420) {
        int32_t e = ease_out((p - 300) * 1000 / 120);
        s.op = 255 * e / 1000;
        s.k = 300 + 700 * e / 1000;
    } else if (p < 800) s.op = 255 - 255 * ease_out((p - 420) * 1000 / 380) / 1000;
    return s;
}

/* @keyframes d3 1.5 s, dots 0.25 s apart: dim, accent at 30 %, dim again by 60 % */
int32_t face_fx_dot(uint32_t t_ms, int index)
{
    int32_t p = phase(t_ms, 1500, (uint32_t)index * 250);
    if (p < 300) return 255 * ease(p * 1000 / 300) / 1000;
    if (p < 600) return 255 - 255 * ease((p - 300) * 1000 / 300) / 1000;
    return 0;
}
