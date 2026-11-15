#include "poke.h"

bool poke_feed(poke_t *p, uint32_t now_ms)
{
    if (p->fired && now_ms - p->fired_at < POKE_COOLDOWN_MS) return false;
    if (p->n == POKE_TAPS) {
        for (int i = 1; i < POKE_TAPS; i++) p->t[i - 1] = p->t[i];
        p->n--;
    }
    p->t[p->n++] = now_ms;
    if (p->n < POKE_TAPS || now_ms - p->t[0] > POKE_WINDOW_MS) return false;
    p->fired = true;
    p->fired_at = now_ms;
    p->n = 0; /* the next one needs 5 new taps */
    return true;
}
