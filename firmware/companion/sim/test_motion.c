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
static motion_event_t swing(motion_t *m, int i) /* one end of a shake: a 1.8 g peak, then back through 1 g */
{
    motion_event_t e = feed(m, (i & 1) ? G * 3 / 2 : -G * 3 / 2, 0, G, 1);
    motion_event_t e2 = feed(m, 0, 0, G, 1);
    return e ? e : e2;
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
    for (int i = 0; i < 6 && !e; i++) e = swing(&s, i);
    CHECK_EQ(e, MOTION_SHAKE);
    CHECK_EQ(feed(&s, 0, 0, G, 10), MOTION_NONE);                    /* calm again, and a pause after it */
    for (int i = 0; i < 6; i++) e = swing(&s, i);
    CHECK_EQ(e, MOTION_NONE);                                        /* still inside the 2 s pause */
    feed(&s, 0, 0, G, 100);
    for (int i = 0; i < 6 && !(e = swing(&s, i)); i++) {}
    CHECK_EQ(e, MOTION_SHAKE);                                       /* and again once the pause is over */

    /* one bump is not a shake */
    motion_t b = {0};
    feed(&b, 0, 0, G, 5);
    CHECK_EQ(feed(&b, G, 0, G, 1), MOTION_NONE);
    CHECK_EQ(feed(&b, 0, 0, G, 60), MOTION_NONE);

    /* moved about by hand: turned and slid, jerky but never past 1.5 g, is not a shake */
    motion_t h = {0};
    feed(&h, 0, 0, G, 5);
    e = MOTION_NONE;
    for (int i = 0; i < 50 && !e; i++)
        e = feed(&h, (i & 1) ? G * 7 / 10 : -G * 7 / 10, (i % 3) * G / 4, G - G / 10, 1); /* 0.7 g swings sideways: up to 1.3 g */
    CHECK_EQ(e, MOTION_NONE);

    /* a bump and a put-down: two peaks are not a shake */
    motion_t b2 = {0};
    feed(&b2, 0, 0, G, 5);
    swing(&b2, 0); swing(&b2, 1);
    CHECK_EQ(feed(&b2, 0, 0, G, 60), MOTION_NONE);

    /* free fall: near zero g for 150 ms */
    motion_t f = {0};
    feed(&f, 0, 0, G, 5);
    CHECK_EQ(feed(&f, 0, 0, 1000, 7), MOTION_NONE);                  /* 120 ms is a quick put-down, not a drop */
    CHECK_EQ(feed(&f, 0, 0, 1000, 2), MOTION_FALL);
    CHECK_EQ(feed(&f, 0, 0, G, 150), MOTION_NONE);                   /* caught; 3 s later it falls again: */
    CHECK_EQ(feed(&f, 0, 0, 1000, 20), MOTION_NONE);                 /* no second fright within 10 s */
    feed(&f, 0, 0, G, 400);
    CHECK_EQ(feed(&f, 0, 0, 1000, 9), MOTION_FALL);                  /* and again once they are over */

    /* lowered briskly: 0.3 g for a while is not a fall */
    motion_t p = {0};
    feed(&p, 0, 0, G, 5);
    CHECK_EQ(feed(&p, 0, 0, G * 3 / 10, 20), MOTION_NONE);

    /* the light moments of a shake are not a fall */
    motion_t sl = {0};
    feed(&sl, 0, 0, G, 5);
    swing(&sl, 0); swing(&sl, 1);                                    /* two peaks */
    CHECK(feed(&sl, 0, 0, 1000, 9) != MOTION_FALL);

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
    for (int i = 0; i < 6 && !(e = swing(&w, i)); i++) {}
    CHECK_EQ(e, MOTION_SHAKE);
    return g_failed ? 1 : 0;
}
