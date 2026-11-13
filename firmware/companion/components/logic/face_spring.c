#include "face_spring.h"

#define Q16 65536LL
#define LIMIT 4096
#define MAX_CATCHUP_MS 250u
#define STEP_MS 10u

static int32_t bound(int32_t v)
{
    return v > LIMIT ? LIMIT : v < -LIMIT ? -LIMIT : v;
}

void face_spring_init(face_spring_t *s, int32_t value)
{
    if (!s) return;
    s->value_q16 = (int64_t)bound(value) * Q16;
    s->velocity_q16 = 0;
}

void face_spring_step(face_spring_t *s, int32_t target, uint32_t elapsed_ms)
{
    if (!s || !elapsed_ms) return;
    int64_t goal = (int64_t)bound(target) * Q16;
    if (s->value_q16 == goal && s->velocity_q16 == 0) return;
    if (elapsed_ms > MAX_CATCHUP_MS) elapsed_ms = MAX_CATCHUP_MS;
    while (elapsed_ms) {
        uint32_t dt = elapsed_ms > STEP_MS ? STEP_MS : elapsed_ms;
        /* k=196/s², c=28/s: critically damped for a continuous spring.
         * Substeps bound numerical error at variable frame rates. */
        int64_t acceleration = (goal - s->value_q16) * 196 - s->velocity_q16 * 28;
        s->velocity_q16 += acceleration * dt / 1000;
        s->value_q16 += s->velocity_q16 * dt / 1000;
        if (s->value_q16 > LIMIT * Q16) { s->value_q16 = LIMIT * Q16; s->velocity_q16 = 0; }
        if (s->value_q16 < -LIMIT * Q16) { s->value_q16 = -LIMIT * Q16; s->velocity_q16 = 0; }
        elapsed_ms -= dt;
    }
    /* Avoid subpixel jitter and fixed-point limit cycles. */
    int64_t distance = goal - s->value_q16;
    if (distance > -Q16 / 128 && distance < Q16 / 128 &&
        s->velocity_q16 > -Q16 / 64 && s->velocity_q16 < Q16 / 64) {
        s->value_q16 = goal; s->velocity_q16 = 0;
    }
}

int32_t face_spring_value(const face_spring_t *s)
{
    if (!s) return 0;
    return (int32_t)(s->value_q16 >= 0 ? (s->value_q16 + Q16 / 2) / Q16 :
                     -((-s->value_q16 + Q16 / 2) / Q16));
}
