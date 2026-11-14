#pragma once
/* Face data and pure helpers, exposed for host tests. Not a public API.
 * All geometry is the design's (ACTUAL AELYS Companion, CompanionFace CSS): a 300x170 box at scale 1. */
#include <stdbool.h>
#include <stdint.h>
#include "ui.h"

#define FACE_W 300
#define FACE_H 170

typedef enum { EYE_PILL, EYE_ARC /* sleeping: U-shaped line */, EYE_RING /* dizzy */, EYE_DOT /* offline */ } face_eye_kind_t;
typedef enum {
    LID_NONE,
    LID_SLANT, /* black mask over the top of the eye, cut along a line (worried, sad, annoyed) */
    LID_DROOP, /* the same with a flat cut that moves (sleepy) */
    LID_DOME,  /* black ellipse over the lower part: the closed, smiling eye (happy, proud, love) */
    LID_RELAX, /* rounded top lid, animated independently from eye-group motion */
} face_lid_t;
typedef enum {
    MOT_NONE, MOT_LOOK, MOT_HOP, MOT_HOP_SLOW, MOT_SWAY, MOT_BREATHE, MOT_JIT, MOT_SINK, MOT_SINK_SLOW, MOT_POP,
    MOT_TILT, MOT_WOBBLE, MOT_HUFF, MOT_PARTY, MOT_SHAKE, MOT_PEEK, MOT_PONDER,
    MOT_JUMP, MOT_SHIVER, MOT_DRIFT, MOT_SEARCH, MOT_BREATHE_SLOW,
    MOT_SINK_RELIEF, MOT_SINK_LETDOWN, MOT_CHEEKY, MOT_COUNT
} face_motion_t;

typedef struct {
    int16_t x, y, w, h, r;         /* the eye's box and corner radius, px; x is the left edge */
    int16_t star_x, star_y, star;  /* highlight inside the eye: offset and edge, px; star 0 = none */
    int16_t lid_y10, lid_slope;    /* LID_SLANT: cut line height at the eye's middle (tenths of px, from the
                                    * eye's top) and slope (permille, + = lower to the right) */
} face_eye_t;

typedef struct { int16_t x, y, size, delay_ms; } face_fx_t; /* position of the effect's box in the face, px */

typedef enum { BLINK_STANDARD, BLINK_DOUBLE, BLINK_WINK, BLINK_WAKE } face_blink_style_t;

typedef struct {
    face_eye_t eye[2];            /* [0] left, [1] right */
    uint8_t kind, lid, motion;
    uint8_t blink_style;
    uint16_t blink_ms;            /* blink period, 0 = none */
    uint8_t border;               /* ring / arc thickness, px */
    uint32_t color;               /* flat colour of arc, ring and dot */
    uint32_t gradient_top, gradient_bottom; /* 0 = normal purple gradient */
    uint8_t star_opacity;         /* 0 = default full opacity */
    uint8_t glow_width;           /* shadow width in face pixels; 0 = no glow */
    uint8_t n_spark, n_zz, n_heart, n_line;
    bool drop, cheeks, dots, confetti;
    uint16_t drop_ms;             /* drip period */
    face_fx_t spark[3], drop_at, zz[2], heart[2], line[3]; /* line: size = rotation in degrees */
} face_mood_t;

const face_mood_t *face_mood_def(mood_t m); /* NULL if out of range */

/* `.ey` transform of the eye group at t_ms into the loop: translation px*100, rotation deg*100 about the
 * face centre, scale permille. */
typedef struct { int32_t tx, ty, rot, sc; } face_group_t;
face_group_t face_group_at(face_motion_t m, uint32_t t_ms);
uint32_t face_motion_period(face_motion_t m);
/* Eye openness (permille, 80..1000) at t_ms: closes at 93..96 % of the period, opens again by 100 %. */
int32_t face_blink_x1000(uint32_t period_ms, uint32_t t_ms);
int32_t face_eye_openness(const face_mood_t *m, int side, uint32_t t_ms);
int32_t face_relax_lid_y100(uint32_t t_ms);
typedef struct { int16_t dy100, angle; uint8_t opacity; } face_confetti_state_t;
face_confetti_state_t face_confetti_at(uint32_t t_ms, uint32_t delay_ms);

/* Effect loops. op = opacity 0..255; dx, dy = offset px*100; k = size permille. */
typedef struct { int32_t op, dx, dy, k; } face_fx_state_t;
face_fx_state_t face_fx_rise(uint32_t t_ms, uint32_t period_ms, uint32_t delay_ms); /* z and hearts */
face_fx_state_t face_fx_drip(uint32_t t_ms, uint32_t period_ms);                    /* drops */
face_fx_state_t face_fx_twinkle(uint32_t t_ms, uint32_t delay_ms);                  /* sparkles */
face_fx_state_t face_fx_burst(uint32_t t_ms);                                       /* surprised lines */
int32_t face_fx_dot(uint32_t t_ms, int index); /* offline dots: 0..255 mix of dim to accent */

/* Pre-rendered A8 shapes (img_fx.c, tools/gen_face_fx.py), nearest size to the requested one. */
const lv_image_dsc_t *face_img_star(int32_t px);   /* edge */
/* Width clamped to 5..26; height rounded from openness in permille and clamped to 1..ceil(width * 1.12). */
const lv_image_dsc_t *face_img_star_squashed(int32_t width_key, int32_t openness_permille);
const lv_image_dsc_t *face_img_heart(int32_t w);
const lv_image_dsc_t *face_img_drop(int32_t px);   /* box edge before the 45 degree turn */
const lv_image_dsc_t *face_img_z(int32_t h);       /* glyph height */
