#include "orient.h"

#define DOWN_Z_MG      800
#define DOWN_XY_MG     300
#define DOWN_HOLD_MS   1000
#define UP_HOLD_MS     200 /* a table tap is a one-sample excursion, not a flip */
#define STILL_MG       50
#define STILL_MS       2000
#define LIFT_HOLD_MS   300
#define CLAMP_MG       4000 /* keeps 1000*dot^2 inside int64 */

static bool elapsed(uint32_t now, uint32_t since, uint32_t ms) { return (int32_t)(now - since) >= (int32_t)ms; }
static int  absi(int v) { return v < 0 ? -v : v; }
static int  clampg(int v) { return v > CLAMP_MG ? CLAMP_MG : v < -CLAMP_MG ? -CLAMP_MG : v; }

void orient_init(orient_t *o, int8_t face_down_z_sign)
{
    *o = (orient_t){ .z_sign = face_down_z_sign < 0 ? -1 : 1 };
}

static void reset_tracking(orient_t *o)
{
    o->have_avg = o->have_rest = o->rest_taken = o->lift_pending = o->lift_fired = false;
}

/* angle(a, rest) > 25 deg: dot <= 0 is already past 90 deg, else dot^2 < cos^2(25) |a|^2 |r|^2 (821/1000) */
static bool lifted(const int a[3], const int16_t r[3])
{
    int64_t dot = 0, aa = 0, rr = 0;
    for (int i = 0; i < 3; i++) {
        dot += (int64_t)a[i] * r[i];
        aa += (int64_t)a[i] * a[i];
        rr += (int64_t)r[i] * r[i];
    }
    if (aa == 0 || rr == 0) return false; /* free fall / no data: not a lift */
    return dot <= 0 || 1000 * dot * dot < 821 * aa * rr;
}

orient_ev_t orient_update(orient_t *o, int16_t ax_mg, int16_t ay_mg, int16_t az_mg, uint32_t now_ms)
{
    const int a[3] = { clampg(ax_mg), clampg(ay_mg), clampg(az_mg) };

    if (o->z_sign * a[2] >= DOWN_Z_MG && absi(a[0]) <= DOWN_XY_MG && absi(a[1]) <= DOWN_XY_MG) {
        o->up_pending = false;
        if (!o->down_pending) { o->down_pending = true; o->down_since_ms = now_ms; }
        if (!o->down && elapsed(now_ms, o->down_since_ms, DOWN_HOLD_MS)) {
            o->down = true;
            reset_tracking(o);
            return ORIENT_FACE_DOWN;
        }
    } else {
        o->down_pending = false;
        if (o->down) {
            if (!o->up_pending) { o->up_pending = true; o->up_since_ms = now_ms; }
            if (elapsed(now_ms, o->up_since_ms, UP_HOLD_MS)) {
                o->down = o->up_pending = false;
                reset_tracking(o);
                return ORIENT_FACE_UP;
            }
        }
    }
    if (o->down) return ORIENT_NONE;

    /* rest vector: smoothed reading, captured once per 2 s window where every axis stays within 50 mg of it */
    bool moved = !o->have_avg;
    for (int i = 0; i < 3 && !moved; i++) moved = absi(a[i] - o->avg[i]) >= STILL_MG;
    if (moved) {
        o->still_since_ms = now_ms;
        o->rest_taken = false;
    }
    for (int i = 0; i < 3; i++) /* follows even while moving: +-40 mg noise settles around its mean instead of resetting forever */
        o->avg[i] = (int16_t)(o->have_avg ? o->avg[i] + (a[i] - o->avg[i]) / 4 : a[i]);
    o->have_avg = true;
    if (!o->rest_taken && elapsed(now_ms, o->still_since_ms, STILL_MS)) {
        for (int i = 0; i < 3; i++) o->rest[i] = o->avg[i];
        o->have_rest = o->rest_taken = true;
        o->lift_pending = o->lift_fired = false;
    }

    if (!o->have_rest) return ORIENT_NONE;
    if (!lifted(a, o->rest)) {
        o->lift_pending = o->lift_fired = false;
        return ORIENT_NONE;
    }
    if (!o->lift_pending) { o->lift_pending = true; o->lift_since_ms = now_ms; }
    if (!o->lift_fired && elapsed(now_ms, o->lift_since_ms, LIFT_HOLD_MS)) {
        o->lift_fired = true;
        return ORIENT_LIFT;
    }
    return ORIENT_NONE;
}
