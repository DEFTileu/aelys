#pragma once
/* Face-down and lift detection from accelerometer mg samples. Integer-only, pure C, no IDF. */
#include <stdbool.h>
#include <stdint.h>

typedef enum { ORIENT_NONE, ORIENT_FACE_DOWN, ORIENT_FACE_UP, ORIENT_LIFT } orient_ev_t;
typedef struct {
    int16_t rest[3];
    uint32_t still_since_ms, down_since_ms;
    bool down, have_rest;
    int8_t z_sign;
    /* internal tracking */
    int16_t avg[3];
    uint32_t lift_since_ms, up_since_ms;
    bool down_pending, up_pending, have_avg, rest_taken, lift_pending, lift_fired;
} orient_t;

/* face_down_z_sign: sign (+1/-1) of az while the board lies face-down */
void        orient_init(orient_t *o, int8_t face_down_z_sign);
/* Call at the IMU rate. FACE_DOWN: face-down 1000 ms; FACE_UP: it stopped for 200 ms; LIFT: >25 deg from rest for 300 ms. */
orient_ev_t orient_update(orient_t *o, int16_t ax_mg, int16_t ay_mg, int16_t az_mg, uint32_t now_ms);
