#include "check.h"
#include "timer_core.h"

static void test_timer(void)
{
    tmr_t t;
    tmr_init(&t, 60000);
    CHECK_EQ(t.st, TMR_SET);
    CHECK_EQ(tmr_left_ms(&t, 5), 60000);
    CHECK(!tmr_poll(&t, 999999));                   /* nothing runs in SET */
    tmr_set_preset(&t, 180000);
    CHECK_EQ(tmr_left_ms(&t, 5), 180000);
    tmr_toggle(&t, 1000);                           /* start */
    CHECK_EQ(t.st, TMR_RUN);
    tmr_set_preset(&t, 60000);                      /* ignored while running */
    CHECK_EQ(t.preset_ms, 180000);
    CHECK_EQ(tmr_left_ms(&t, 61000), 120000);
    tmr_toggle(&t, 61000);                          /* pause freezes the rest */
    CHECK_EQ(t.st, TMR_PAUSED);
    CHECK_EQ(tmr_left_ms(&t, 500000), 120000);
    CHECK(!tmr_poll(&t, 900000));
    tmr_toggle(&t, 500000);                         /* resume */
    CHECK_EQ(tmr_left_ms(&t, 560000), 60000);
    CHECK(!tmr_poll(&t, 619999));
    CHECK(tmr_poll(&t, 620000));                    /* the exact end */
    CHECK_EQ(t.st, TMR_DONE);
    CHECK(!tmr_poll(&t, 700000));                   /* reported once */
    CHECK_EQ(tmr_left_ms(&t, 700000), 0);
    tmr_toggle(&t, 700000);                         /* a toggle does nothing in DONE */
    CHECK_EQ(t.st, TMR_DONE);
    tmr_add_minute(&t, 700000);                     /* +1 min, for this run only */
    CHECK_EQ(t.st, TMR_RUN);
    CHECK_EQ(t.total_ms, 60000);
    CHECK_EQ(tmr_left_ms(&t, 730000), 30000);
    tmr_add_minute(&t, 730000);                     /* not in RUN */
    CHECK_EQ(tmr_left_ms(&t, 730000), 30000);
    CHECK(tmr_poll(&t, 760000));
    tmr_reset(&t);                                  /* back to the preset */
    CHECK_EQ(t.st, TMR_SET);
    CHECK_EQ(tmr_left_ms(&t, 0), 180000);
    CHECK_EQ(t.total_ms, 180000);
}

static void test_timer_tick_wrap(void)
{
    tmr_t t;
    tmr_init(&t, 10000);
    tmr_toggle(&t, 0xFFFFFFFFu - 3000);             /* the end is past the wrap */
    CHECK_EQ(tmr_left_ms(&t, 0xFFFFFFFFu), 7000);
    CHECK(!tmr_poll(&t, 5000));
    CHECK(tmr_poll(&t, 7000));
}

static void test_stopwatch(void)
{
    sw_t s = {0};
    CHECK(!sw_lap(&s, 10));                         /* no lap while stopped */
    sw_toggle(&s, 1000);
    CHECK_EQ(sw_elapsed_ms(&s, 3500), 2500);
    CHECK(sw_lap(&s, 39900));
    CHECK_EQ(s.lap_ms[0], 38900);
    CHECK(sw_lap(&s, 81100));
    CHECK_EQ(s.lap_ms[0], 41200);
    CHECK_EQ(s.lap_ms[1], 38900);
    CHECK(!sw_reset(&s));                           /* not while running */
    sw_toggle(&s, 90000);                           /* stop */
    CHECK_EQ(sw_elapsed_ms(&s, 1000000), 89000);
    CHECK(!sw_lap(&s, 95000));
    sw_toggle(&s, 100000);                          /* start again: the stopped time stays out */
    CHECK_EQ(sw_elapsed_ms(&s, 110000), 99000);
    CHECK(sw_lap(&s, 110000));
    CHECK(sw_lap(&s, 111000));
    CHECK(sw_lap(&s, 112000));
    CHECK_EQ(s.n_laps, 5);
    CHECK_EQ(s.lap_ms[0], 1000);                    /* only the last three are kept, newest first */
    CHECK_EQ(s.lap_ms[1], 1000);
    CHECK_EQ(s.lap_ms[2], 18900);
    sw_toggle(&s, 113000);
    CHECK(sw_reset(&s));
    CHECK_EQ(sw_elapsed_ms(&s, 200000), 0);
    CHECK_EQ(s.n_laps, 0);
    CHECK_EQ(s.lap_ms[0], 0);
}

int main(void)
{
    test_timer();
    test_timer_tick_wrap();
    test_stopwatch();
    return g_failed ? 1 : 0;
}
