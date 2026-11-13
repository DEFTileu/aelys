#include "check.h"
#include "gesture.h"

/* A finger that goes down at (x0,y0), is seen at (x1,y1) after dt ms and then lifts. */
static gesture_t run(int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint32_t dt)
{
    gesture_ctx_t g = {0};
    CHECK_EQ(gesture_feed(&g, true, x0, y0, 1000), GEST_NONE);
    CHECK_EQ(gesture_feed(&g, true, x1, y1, 1000 + dt / 2), GEST_NONE); /* nothing fires before the release */
    return gesture_feed(&g, false, 0, 0, 1000 + dt);                    /* the release read carries no position */
}

static void test_tap(void)
{
    CHECK_EQ(run(200, 200, 200, 200, 120), GEST_TAP);
    CHECK_EQ(run(200, 200, 212, 190, 400), GEST_TAP);   /* 15.6 px, exactly 400 ms */
    CHECK_EQ(run(200, 200, 200, 200, 401), GEST_NONE);  /* held too long */
    CHECK_EQ(run(200, 200, 215, 215, 100), GEST_NONE);  /* 21 px */
}

static void test_slow_drag_is_none(void)
{
    CHECK_EQ(run(100, 233, 300, 233, 601), GEST_NONE);
    CHECK_EQ(run(100, 233, 300, 233, 600), GEST_SWIPE_RIGHT);
}

static void test_swipe_left_right(void)
{
    CHECK_EQ(run(300, 233, 200, 240, 200), GEST_SWIPE_LEFT);
    CHECK_EQ(run(100, 233, 200, 240, 200), GEST_SWIPE_RIGHT);
    CHECK_EQ(run(100, 233, 159, 233, 200), GEST_NONE);          /* 59 px: too short, too far for a tap */
    CHECK_EQ(run(100, 233, 160, 233, 200), GEST_SWIPE_RIGHT);   /* 60 px */
}

static void test_vertical_drag_is_none(void)
{
    CHECK_EQ(run(200, 100, 200, 300, 200), GEST_NONE);
    CHECK_EQ(run(100, 100, 200, 160, 200), GEST_NONE);          /* |dx| < 2|dy| */
    CHECK_EQ(run(100, 100, 220, 160, 200), GEST_SWIPE_RIGHT);   /* |dx| = 2|dy| */
}

static void test_one_event_per_touch(void)
{
    gesture_ctx_t g = {0};
    gesture_feed(&g, true, 50, 50, 0);
    CHECK_EQ(gesture_feed(&g, false, 0, 0, 100), GEST_TAP);
    CHECK_EQ(gesture_feed(&g, false, 0, 0, 120), GEST_NONE);    /* still up: nothing more */
}

/* Short press of one key = BTN_TOP / BTN_LOW; two keys together (the combo) and long holds give nothing. */
static void test_buttons(void)
{
    btn_ctx_t b = {0};
    CHECK_EQ(btn_feed(&b, true, false, 100), 0);
    CHECK_EQ(btn_feed(&b, false, false, 300), BTN_TOP);
    CHECK_EQ(btn_feed(&b, false, true, 1000), 0);
    CHECK_EQ(btn_feed(&b, false, false, 1100), BTN_LOW);
    CHECK_EQ(btn_feed(&b, true, false, 2000), 0);
    CHECK_EQ(btn_feed(&b, false, false, 2501), 0);              /* a long press is not a click */
    CHECK_EQ(btn_feed(&b, true, false, 3000), 0);
    CHECK_EQ(btn_feed(&b, true, true, 3100), 0);                /* the combo started */
    CHECK_EQ(btn_feed(&b, false, true, 3200), 0);
    CHECK_EQ(btn_feed(&b, false, false, 3300), 0);              /* neither release counts */
    CHECK_EQ(btn_feed(&b, true, false, 4000), 0);
    CHECK_EQ(btn_feed(&b, false, false, 4100), BTN_TOP);        /* and it re-arms */
}

/* A key level counts only after 3 equal polls in a row: a bounce cannot make a second click. */
static void test_debounce(void)
{
    debounce_t d = {0};
    CHECK(!debounce_feed(&d, true));
    CHECK(!debounce_feed(&d, true));
    CHECK(debounce_feed(&d, true));                    /* 3rd poll */
    CHECK(debounce_feed(&d, false));                   /* a glitch ... */
    CHECK(debounce_feed(&d, true));                    /* ... is gone before it counts */
    CHECK(debounce_feed(&d, false));
    CHECK(debounce_feed(&d, false));
    CHECK(!debounce_feed(&d, false));                  /* released for 3 polls */

    /* a bouncing release gives one click, not two */
    btn_ctx_t b = {0};
    debounce_t k = {0};
    const bool raw[] = { 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0 }; /* press, bounce on release, then silence */
    int clicks = 0;
    for (unsigned i = 0; i < sizeof raw / sizeof *raw; i++)
        clicks += btn_feed(&b, false, debounce_feed(&k, raw[i]), 10 + 4 * i) != 0;
    CHECK_EQ(clicks, 1);
}

static void test_moved(void)
{
    gesture_ctx_t g = {0};
    CHECK(!gesture_moved(&g));                         /* no finger */
    gesture_feed(&g, true, 100, 100, 0);
    gesture_feed(&g, true, 110, 112, 10);
    CHECK(!gesture_moved(&g));                         /* 15.6 px */
    gesture_feed(&g, true, 115, 115, 20);
    CHECK(gesture_moved(&g));                          /* 21.2 px: no longer a tap or a hold */
    gesture_feed(&g, false, 0, 0, 30);
    CHECK(!gesture_moved(&g));
}

int main(void)
{
    test_tap();
    test_slow_drag_is_none();
    test_swipe_left_right();
    test_vertical_drag_is_none();
    test_one_event_per_touch();
    test_buttons();
    test_debounce();
    test_moved();
    return g_failed ? 1 : 0;
}
