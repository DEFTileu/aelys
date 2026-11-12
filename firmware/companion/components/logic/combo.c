#include <string.h>
#include "combo.h"

void combo_reset(combo_t *c) { memset(c, 0, sizeof *c); }

int combo_update(combo_t *c, bool a_down, bool b_down, uint32_t now_ms)
{
    c->a = a_down;
    c->b = b_down;
    bool both = a_down && b_down;

    switch (c->state) {
    case COMBO_IDLE:
        if (!both) return -1;
        c->state = COMBO_HOLDING;
        c->since_ms = now_ms;
        return 0;
    case COMBO_HOLDING: {
        if (!both) { c->state = COMBO_IDLE; return -1; }
        uint32_t held = now_ms - c->since_ms;
        if (held >= COMBO_HOLD_MS) { c->state = COMBO_FIRED; return 100; }
        return (int)(held * 100u / COMBO_HOLD_MS);
    }
    case COMBO_FIRED:
        /* needs a full release (either button up) before it can re-arm */
        if (!both) c->state = COMBO_IDLE;
        return -1;
    }
    return -1;
}
