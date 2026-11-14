/* Body gestures from the accelerometer. */
#include "check.h"
#include "motion.h"

#define G 16384

static uint32_t t;
static motion_event_t feed(motion_t *m, int32_t x, int32_t y, int32_t z, int n) /* n samples, 20 ms apart; the last non-NONE result */
{
    motion_event_t last = MOTION_NONE;
    for (int i = 0; i < n; i++) { motion_event_t e = motion_update(m, x, y, z, t += 20); if (e) last = e; }
    return last;
}

int main(void)
{
    motion_t m = {0};
    t = 1000;
    CHECK_EQ(feed(&m, 0, 0, G, 50), MOTION_NONE);                   /* lying on the desk */
    CHECK_EQ(feed(&m, 300, -200, G - 100, 10), MOTION_NONE);         /* small nudges are nothing */

    /* shake: back and forth by a full g, a few times */
    motion_t s = {0};
    feed(&s, 0, 0, G, 5);
    motion_event_t e = MOTION_NONE;
    for (int i = 0; i < 6 && !e; i++) e = feed(&s, (i & 1) ? G : -G, 0, G, 1);
    CHECK_EQ(e, MOTION_SHAKE);
    CHECK_EQ(feed(&s, 0, 0, G, 10), MOTION_NONE);                    /* calm again, and a pause after it */
    for (int i = 0; i < 6; i++) e = feed(&s, (i & 1) ? G : -G, 0, G, 1);
    CHECK_EQ(e, MOTION_NONE);                                        /* still inside the 2 s pause */
    feed(&s, 0, 0, G, 100);
    for (int i = 0; i < 6 && !(e = feed(&s, (i & 1) ? G : -G, 0, G, 1)); i++) {}
    CHECK_EQ(e, MOTION_SHAKE);                                       /* and again once the pause is over */

    /* one bump is not a shake */
    motion_t b = {0};
    feed(&b, 0, 0, G, 5);
    CHECK_EQ(feed(&b, G, 0, G, 1), MOTION_NONE);
    CHECK_EQ(feed(&b, 0, 0, G, 60), MOTION_NONE);

    /* free fall: near zero g for 80 ms */
    motion_t f = {0};
    feed(&f, 0, 0, G, 5);
    CHECK_EQ(feed(&f, 0, 0, 1000, 2), MOTION_NONE);                  /* 40 ms is too short */
    CHECK_EQ(feed(&f, 0, 0, 1000, 4), MOTION_FALL);

    /* lift: lying still 10 s, then it moves */
    motion_t l = {0};
    feed(&l, 0, 0, G, 600);
    CHECK_EQ(feed(&l, 0, 3000, G - 500, 1), MOTION_LIFT);
    CHECK_EQ(feed(&l, 0, 0, G, 1), MOTION_NONE);                     /* moving again soon after is not another lift */
    motion_t l2 = {0};
    feed(&l2, 0, 0, G, 100);                                          /* only 2 s still: no lift */
    CHECK_EQ(feed(&l2, 0, 3000, G - 500, 1), MOTION_NONE);

    /* face down for 1.5 s, then back up */
    motion_t d = {0};
    feed(&d, 0, 0, G, 5);
    CHECK_EQ(feed(&d, 0, 0, -G, 50), MOTION_NONE);                   /* 1 s face down: not yet */
    CHECK_EQ(feed(&d, 0, 0, -G, 30), MOTION_FACE_DOWN);
    CHECK_EQ(feed(&d, 0, 0, -G, 200), MOTION_NONE);                   /* reported once */
    CHECK_EQ(feed(&d, (G), 0, -G, 10), MOTION_NONE);                  /* jostled while face down: no shake */
    CHECK_EQ(feed(&d, 0, 0, G, 20), MOTION_FACE_UP);
    CHECK_EQ(feed(&d, 0, 0, G, 50), MOTION_NONE);

    /* the clock wraps */
    motion_t w = {0};
    t = UINT32_MAX - 200;
    feed(&w, 0, 0, G, 5);
    for (int i = 0; i < 6 && !(e = feed(&w, (i & 1) ? G : -G, 0, G, 1)); i++) {}
    CHECK_EQ(e, MOTION_SHAKE);
    return g_failed ? 1 : 0;
}
