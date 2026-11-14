#include "motion.h"
#include <stdlib.h>

#define G 16384
#define JOLT (G / 2)          /* a change of half a g between two samples 20 ms apart */
#define SHAKE_JOLTS 4
#define SHAKE_MS 1000
#define FALL_G2 ((int64_t)(G * 35 / 100) * (G * 35 / 100)) /* below 0.35 g: free fall */
#define FALL_MS 80
#define STILL (G / 25)        /* under 0.04 g between samples is "lying still" */
#define LIFT (G / 7)          /* then 0.14 g of movement is a pick-up */
#define LIFT_STILL_MS 10000
#define DOWN_Z (-G * 3 / 4)
#define DOWN_MS 1500
#define UP_MS 300
#define QUIET_MS 2000
/* shortcut: thresholds are first guesses from the datasheet scale, tune them on the board if gestures fire too easily or not at all */

static bool before(uint32_t a, uint32_t b) { return (int32_t)(a - b) < 0; }

motion_event_t motion_update(motion_t *m, int32_t ax, int32_t ay, int32_t az, uint32_t now)
{
    if (!m->primed) {
        m->primed = true;
        m->px = ax; m->py = ay; m->pz = az;
        m->still_since = m->quiet_until = now;
        return MOTION_NONE;
    }
    int32_t d = abs(ax - m->px) + abs(ay - m->py) + abs(az - m->pz);
    m->px = ax; m->py = ay; m->pz = az;
    uint32_t still_for = now - m->still_since;
    if (d >= STILL) m->still_since = now;

    /* face down and back up: a held pose, so the pause after a gesture does not apply */
    if (m->face_down) {
        if (az <= 0) m->up_pending = false;
        else if (!m->up_pending) { m->up_pending = true; m->up_since = now; }
        else if ((uint32_t)(now - m->up_since) >= UP_MS) {
            m->face_down = m->up_pending = false;
            m->quiet_until = now + QUIET_MS; /* turning it over is not also a shake or a lift */
            return MOTION_FACE_UP;
        }
        return MOTION_NONE;
    }
    if (az >= DOWN_Z) m->down_pending = false;
    else if (!m->down_pending) { m->down_pending = true; m->down_since = now; }
    else if ((uint32_t)(now - m->down_since) >= DOWN_MS) {
        m->face_down = true;
        m->down_pending = false;
        return MOTION_FACE_DOWN;
    }

    int64_t g2 = (int64_t)ax * ax + (int64_t)ay * ay + (int64_t)az * az;
    if (g2 >= FALL_G2) m->low = false;
    else if (!m->low) { m->low = true; m->low_since = now; }
    if (d >= JOLT) {
        for (int i = SHAKE_JOLTS - 1; i > 0; i--) m->jolt_ms[i] = m->jolt_ms[i - 1];
        m->jolt_ms[0] = now | 1; /* 0 means "no jolt" */
    }
    if (before(now, m->quiet_until)) return MOTION_NONE;

    motion_event_t e = MOTION_NONE;
    if (m->low && (uint32_t)(now - m->low_since) >= FALL_MS) e = MOTION_FALL;
    else if (m->jolt_ms[SHAKE_JOLTS - 1] && (uint32_t)(now - m->jolt_ms[SHAKE_JOLTS - 1]) <= SHAKE_MS) e = MOTION_SHAKE;
    else if (d >= LIFT && still_for >= LIFT_STILL_MS) e = MOTION_LIFT;
    if (e != MOTION_NONE) {
        m->quiet_until = now + QUIET_MS;
        for (int i = 0; i < SHAKE_JOLTS; i++) m->jolt_ms[i] = 0;
        m->low = false;
    }
    return e;
}
