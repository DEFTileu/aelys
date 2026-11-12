#include "orient.h"
#include "check.h"

/* Feed a constant sample every 20 ms for ms milliseconds; return the first non-NONE event. */
static orient_ev_t feed(orient_t *o, uint32_t *t, uint32_t ms, int ax, int ay, int az)
{
    orient_ev_t first = ORIENT_NONE;
    for (uint32_t n = 0; n < ms / 20; n++, *t += 20) {
        orient_ev_t e = orient_update(o, (int16_t)ax, (int16_t)ay, (int16_t)az, *t);
        if (first == ORIENT_NONE) first = e;
    }
    return first;
}

/* Board flat, face-up: gravity on +z. Face-down is then z_sign = -1 (az = -1000). */
static void settle(orient_t *o, uint32_t *t)
{
    orient_init(o, -1);
    *t = 1000;
    CHECK_EQ(feed(o, t, 2200, 0, 0, 1000), ORIENT_NONE);
    CHECK(o->have_rest);
}

static void test_face_down_needs_1s(void)
{
    orient_t o; uint32_t t = 0;
    orient_init(&o, -1);
    CHECK_EQ(feed(&o, &t, 900, 20, -30, -990), ORIENT_NONE);
    CHECK_EQ(feed(&o, &t, 200, 20, -30, -990), ORIENT_FACE_DOWN);
    CHECK_EQ(feed(&o, &t, 3000, 20, -30, -990), ORIENT_NONE); /* reported once */
}

static void test_face_down_interrupted_restarts(void)
{
    orient_t o; uint32_t t = 0;
    orient_init(&o, -1);
    CHECK_EQ(feed(&o, &t, 900, 0, 0, -1000), ORIENT_NONE);
    CHECK_EQ(feed(&o, &t, 40, 0, 0, 1000), ORIENT_NONE);
    CHECK_EQ(feed(&o, &t, 900, 0, 0, -1000), ORIENT_NONE);
}

static void test_face_down_ignores_steep_tilt(void)
{
    orient_t o; uint32_t t = 0;
    orient_init(&o, -1);
    CHECK_EQ(feed(&o, &t, 3000, 500, 0, -850), ORIENT_NONE); /* |ax| > 300 mg: propped up, not flat */
}

static void test_face_up_after_down(void)
{
    orient_t o; uint32_t t = 0;
    orient_init(&o, -1);
    CHECK_EQ(feed(&o, &t, 1200, 0, 0, -1000), ORIENT_FACE_DOWN);
    CHECK_EQ(feed(&o, &t, 100, 0, 0, 1000), ORIENT_FACE_UP);
    CHECK_EQ(feed(&o, &t, 5000, 0, 0, 1000), ORIENT_NONE); /* no LIFT from a stale rest */
}

static void test_tilt_from_rest_is_lift(void)
{
    orient_t o; uint32_t t;
    settle(&o, &t);
    CHECK_EQ(feed(&o, &t, 280, 500, 0, 866), ORIENT_NONE); /* 30 deg, under 300 ms */
    CHECK_EQ(feed(&o, &t, 100, 500, 0, 866), ORIENT_LIFT);
    CHECK_EQ(feed(&o, &t, 1000, 500, 0, 866), ORIENT_NONE);
    /* held still 2 s: a new rest is taken here, so going back to flat is a lift again */
    CHECK_EQ(feed(&o, &t, 2200, 500, 0, 866), ORIENT_NONE);
    CHECK_EQ(feed(&o, &t, 400, 0, 0, 1000), ORIENT_LIFT);
}

static void test_small_tilt_is_not_lift(void)
{
    orient_t o; uint32_t t;
    settle(&o, &t);
    CHECK_EQ(feed(&o, &t, 3000, 342, 0, 940), ORIENT_NONE); /* 20 deg */
}

static void test_flip_over_is_lift(void)
{
    orient_t o; uint32_t t;
    settle(&o, &t);
    CHECK_EQ(feed(&o, &t, 600, 0, 700, -700), ORIENT_LIFT); /* >90 deg from rest, but not flat face-down */
}

static void test_noise_is_not_lift(void)
{
    orient_t o; uint32_t t = 0;
    orient_init(&o, -1);
    for (int i = 0; i < 500; i++) { /* 10 s of +-40 mg jitter on every axis */
        int s = (i % 2) ? 40 : -40;
        orient_ev_t e = orient_update(&o, (int16_t)(s), (int16_t)(-s), (int16_t)(1000 + s), t);
        CHECK_EQ(e, ORIENT_NONE);
        t += 20;
    }
    CHECK(o.have_rest);
}

static void test_wraps_uint32(void)
{
    orient_t o; uint32_t t = 0xFFFFFFFFu - 1000u;
    orient_init(&o, -1);
    CHECK_EQ(feed(&o, &t, 1500, 0, 0, -1000), ORIENT_FACE_DOWN);
}

int main(void)
{
    test_face_down_needs_1s();
    test_face_down_interrupted_restarts();
    test_face_down_ignores_steep_tilt();
    test_face_up_after_down();
    test_tilt_from_rest_is_lift();
    test_small_tilt_is_not_lift();
    test_flip_over_is_lift();
    test_noise_is_not_lift();
    test_wraps_uint32();
    return g_failed ? 1 : 0;
}
