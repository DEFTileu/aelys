#include "tribuf.h"

#define IDX 3u
#define FRESH 0x80u

void tribuf_init(tribuf_t *t, void *s0, void *s1, void *s2)
{
    t->slot[0] = s0; t->slot[1] = s1; t->slot[2] = s2;
    t->back = 0;
    t->front = 2;
    atomic_init(&t->mid, 1);
}

void *tribuf_back(tribuf_t *t) { return t->slot[t->back]; }

void tribuf_publish(tribuf_t *t)
{
    uint8_t old = atomic_exchange(&t->mid, (uint8_t)(t->back | FRESH));
    t->back = old & IDX; /* the reader never holds the middle slot, so the old middle is free to write */
}

const void *tribuf_latest(tribuf_t *t, bool *fresh)
{
    bool f = (atomic_load(&t->mid) & FRESH) != 0;
    if (f) t->front = atomic_exchange(&t->mid, t->front) & IDX;
    if (fresh) *fresh = f;
    return t->slot[t->front];
}
