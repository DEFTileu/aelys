#include "check.h"
#include "poke.h"

static int run(poke_t *p, const uint32_t *t, int n) /* how many of these taps fired */
{
    int fired = 0;
    for (int i = 0; i < n; i++) fired += poke_feed(p, t[i]);
    return fired;
}

static void test_four_taps_do_not_annoy(void)
{
    poke_t p = {0};
    const uint32_t t[] = { 0, 100, 200, 300 };
    CHECK_EQ(run(&p, t, 4), 0);
}

static void test_fifth_tap_in_three_seconds_annoys(void)
{
    poke_t p = {0};
    CHECK(!poke_feed(&p, 1000));
    CHECK(!poke_feed(&p, 1500));
    CHECK(!poke_feed(&p, 2000));
    CHECK(!poke_feed(&p, 2500));
    CHECK(poke_feed(&p, 3000));                 /* the 5th, 2 s after the 1st */

    poke_t q = {0};
    const uint32_t edge[] = { 0, 700, 1400, 2100, 3000 }; /* exactly 3 s: still inside */
    CHECK_EQ(run(&q, edge, 5), 1);
}

static void test_five_taps_over_four_seconds_do_not(void)
{
    poke_t p = {0};
    const uint32_t t[] = { 0, 1000, 2000, 3000, 4000 };
    CHECK_EQ(run(&p, t, 5), 0);
    poke_t q = {0};
    const uint32_t late[] = { 0, 700, 1400, 2100, 3001 }; /* 1 ms too slow */
    CHECK_EQ(run(&q, late, 5), 0);
}

static void test_slow_start_then_burst(void)
{
    poke_t p = {0};                             /* old taps fall out of the window: only the last five count */
    const uint32_t t[] = { 0, 5000, 10000, 10200, 10400, 10600, 10800 };
    CHECK_EQ(run(&p, t, 7), 1);                 /* 10000 .. 10800 */
}

static void test_cool_down(void)
{
    poke_t p = {0};
    const uint32_t first[] = { 0, 100, 200, 300, 400 };
    CHECK_EQ(run(&p, first, 5), 1);
    const uint32_t during[] = { 500, 600, 700, 800, 900, 1000, 4399 }; /* a poked Aelys is not annoyed again for 4 s */
    CHECK_EQ(run(&p, during, 7), 0);
    const uint32_t after[] = { 4400, 4500, 4600, 4700 }; /* the cool-down ends 4 s after the trigger: five new taps needed */
    CHECK_EQ(run(&p, after, 4), 0);
    CHECK(poke_feed(&p, 4800));
}

static void test_cool_down_taps_do_not_count_later(void)
{
    poke_t p = {0};
    const uint32_t first[] = { 0, 10, 20, 30, 40 };
    CHECK_EQ(run(&p, first, 5), 1);
    const uint32_t during[] = { 1000, 2000, 3000, 3500 };
    CHECK_EQ(run(&p, during, 4), 0);
    CHECK(!poke_feed(&p, 4100));                /* one tap after the cool-down is not five */
}

static void test_millisecond_clock_wraps(void)
{
    poke_t p = {0};
    const uint32_t t[] = { 0xFFFFFE00u, 0xFFFFFF00u, 0xFFFFFFFFu, 100, 200 };
    CHECK_EQ(run(&p, t, 5), 1);
}

int main(void)
{
    test_four_taps_do_not_annoy();
    test_fifth_tap_in_three_seconds_annoys();
    test_five_taps_over_four_seconds_do_not();
    test_slow_start_then_burst();
    test_cool_down();
    test_cool_down_taps_do_not_count_later();
    test_millisecond_clock_wraps();
    return g_failed ? 1 : 0;
}
