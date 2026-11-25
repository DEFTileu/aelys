#include "power_fsm.h"

void power_init(power_t *p, uint32_t dim_ms, uint32_t off_ms, uint32_t now_ms)
{
    p->state = PWR_ACTIVE;
    p->face_down = false;
    p->last_activity_ms = now_ms;
    p->dim_ms = dim_ms;
    p->off_ms = off_ms;
}

static void wake(power_t *p, uint32_t now_ms)
{
    p->state = PWR_ACTIVE;
    p->last_activity_ms = now_ms;
}

pwr_state_t power_update(power_t *p, pwr_in_t in, uint32_t now_ms)
{
    switch (in) {
    case PWR_IN_FACE_DOWN:
        p->face_down = true;
        p->state = PWR_OFF;
        break;
    case PWR_IN_TOUCH:
    case PWR_IN_HOLD:
        if (!p->face_down) wake(p, now_ms);
        break;
    case PWR_IN_BUTTON: /* wakes a face-down screen, but the board still lies face-down: keep the latch */
        wake(p, now_ms);
        break;
    case PWR_IN_LIFT:
    case PWR_IN_FACE_UP:
        p->face_down = false;
        wake(p, now_ms);
        break;
    case PWR_IN_TICK:
        if ((int32_t)(now_ms - p->last_activity_ms) >= (int32_t)p->off_ms) p->state = PWR_OFF;
        else if ((int32_t)(now_ms - p->last_activity_ms) >= (int32_t)p->dim_ms && p->state == PWR_ACTIVE)
            p->state = PWR_DIM;
        break;
    }
    return p->state;
}
