#pragma once
/* Body gestures from the accelerometer: pure logic, no IDF. Fed every 20 ms with raw counts (16384 = 1 g); z is the screen normal,
 * positive while the screen faces up (az = +16334 lying on the desk, -16260 face down, measured on the board). */
#include <stdbool.h>
#include <stdint.h>

typedef enum { MOTION_NONE, MOTION_SHAKE, MOTION_FALL, MOTION_LIFT, MOTION_FACE_DOWN, MOTION_FACE_UP } motion_event_t;

typedef struct {
    bool primed, face_down;
    int32_t px, py, pz;          /* the previous sample */
    uint32_t jolt_ms[4];         /* the last four jolts, newest first */
    uint32_t low_since, still_since, down_since, up_since, quiet_until;
    bool low, down_pending, up_pending;
} motion_t;

/* One sample; returns the gesture it completes, or MOTION_NONE. A shake, fall or lift is followed by a 2 s pause. */
motion_event_t motion_update(motion_t *m, int32_t ax, int32_t ay, int32_t az, uint32_t now_ms);
