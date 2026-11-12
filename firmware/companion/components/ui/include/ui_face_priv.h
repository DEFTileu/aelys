#pragma once
/* Face geometry data and pure helpers, exposed for host tests. Not a public API. */
#include <stdbool.h>
#include <stdint.h>
#include "ui.h"

typedef struct {
    int16_t w, h;     /* px at scale 1 */
    int16_t dx, dy;   /* offset of the eye centre from its rest position */
    int16_t r_pct;    /* corner radius, % of the shorter side */
    int16_t lid_pct;  /* top lid, % of the eye height */
    int16_t tilt;     /* lid angle, degrees; + = inner corners lower */
    bool smile;       /* crescent: black dome over the lower part */
    bool hollow;      /* ring instead of a filled eye */
} face_eye_t;

typedef struct {
    face_eye_t eye[2]; /* [0] left, [1] right */
    bool blink;
    bool cheeks, zz, sweat, sparkle, dots;
    char glyph;        /* '!' or '?', 0 = none */
} face_mood_t;

typedef struct { int32_t x, y, w, h, cx, cy; } face_rect_t;

const face_mood_t *face_mood_def(mood_t m); /* NULL if out of range */
/* Eye box in face coordinates. blink_x1000 scales the height around the centre (1000 = open). */
face_rect_t face_eye_rect(const face_eye_t *e, int side /* 0 left, 1 right */, int32_t scale_x100,
                          int32_t blink_x1000);
/* Eye openness (permille, 80..1000) at t_ms into the 5.2 s blink cycle. */
int32_t face_blink_x1000(uint32_t t_ms);
