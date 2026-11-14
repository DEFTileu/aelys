#include <math.h>
#include <string.h>
#include "check.h"
#include "games_core.h"

static void test_ask(void)
{
    bool tone[3] = { false, false, false };
    for (unsigned i = 0; i < GM_N_ANSWERS; i++) {
        const gm_answer_t *a = gm_answer(i);
        CHECK(a->text && strlen(a->text) > 2 && strlen(a->text) < 20); /* short enough for two lines of 28 px */
        tone[a->tone] = true;
    }
    CHECK(tone[GM_YES] && tone[GM_MAYBE] && tone[GM_NO]);
    for (unsigned last = 0; last < GM_N_ANSWERS; last++) {
        bool seen[GM_N_ANSWERS] = { false };
        for (uint32_t r = 0; r < 100; r++) {
            unsigned i = gm_ask_pick(last, r);
            CHECK(i < GM_N_ANSWERS && i != last);
            seen[i] = true;
        }
        for (unsigned i = 0; i < GM_N_ANSWERS; i++) CHECK(seen[i] == (i != last)); /* every other answer can come */
    }
    CHECK_EQ(gm_ask_pick(GM_N_ANSWERS, 5), 5);                       /* nothing before: any of them */
    CHECK_EQ(gm_ask_pick(GM_N_ANSWERS, 5 + 12 * 3), 5);
}

static void test_coin_and_dice(void)
{
    int tails = 0, face[7] = { 0 };
    for (uint32_t r = 0; r < 6000; r++) {
        uint32_t x = r * 2654435761u; /* spread the small numbers over the 32 bits */
        tails += gm_coin_tails(x);
        face[gm_die(x)]++;
    }
    CHECK(tails > 2500 && tails < 3500);
    CHECK_EQ(face[0], 0);
    for (int f = 1; f <= 6; f++) CHECK(face[f] > 700);
    CHECK_EQ(gm_die(0), 1);
    CHECK_EQ(gm_die(5), 6);
    CHECK(!gm_coin_tails(0));
    CHECK(gm_coin_tails(1u << 16));
    for (unsigned f = 1; f <= 6; f++) CHECK_EQ(__builtin_popcount(gm_die_pips(f)), (int)f);
    CHECK_EQ(gm_die_pips(1), 1 << 3);                                 /* the centre alone */
    CHECK_EQ(gm_die_pips(0), 0);
    CHECK_EQ(gm_die_pips(7), 0);
}

static void test_reaction(void)
{
    rx_t x;
    rx_init(&x);
    CHECK_EQ(x.st, RX_IDLE);
    CHECK(!rx_poll(&x, 99999));                                      /* nothing runs before a start */
    rx_tap(&x, 1000, 0);                                             /* first tap starts: the shortest wait */
    CHECK_EQ(x.st, RX_WAIT);
    CHECK_EQ(rx_wait_left(&x, 1000), 1500);
    CHECK(!rx_poll(&x, 2499));
    CHECK_EQ(rx_wait_left(&x, 2400), 100);
    CHECK(rx_poll(&x, 2500));
    CHECK_EQ(x.st, RX_GO);
    CHECK(!rx_poll(&x, 2600));                                       /* once */
    CHECK_EQ(rx_wait_left(&x, 2600), 0);
    rx_tap(&x, 2714, 0);
    CHECK_EQ(x.st, RX_DONE);
    CHECK_EQ(x.ms, 214);
    CHECK_EQ(x.best_ms, 214);
    rx_tap(&x, 3000, 2500);                                          /* the longest wait: 4 s */
    CHECK_EQ(rx_wait_left(&x, 3000), 4000);
    rx_tap(&x, 3500, 0);                                             /* too soon: no time, best unchanged, the wait is off */
    CHECK_EQ(x.st, RX_EARLY);
    CHECK_EQ(x.best_ms, 214);
    CHECK(!rx_poll(&x, 99999));
    rx_tap(&x, 4000, 77);                                            /* a tap after "too soon" starts again */
    CHECK_EQ(x.st, RX_WAIT);
    CHECK(x.go_at >= 4000 + RX_MIN_WAIT_MS && x.go_at <= 4000 + RX_MIN_WAIT_MS + RX_SPAN_MS);
    for (uint32_t r = 0; r < 10000; r += 7) { /* any draw stays between 1.5 and 4 s */
        rx_init(&x);
        rx_tap(&x, 0, r);
        CHECK(x.st == RX_WAIT && x.go_at >= 1500 && x.go_at <= 4000);
    }
    rx_poll(&x, x.go_at);
    rx_tap(&x, x.shown_at + 150, 0);                                  /* a better one replaces the best, a worse one does not */
    CHECK_EQ(x.best_ms, 150);
    rx_tap(&x, 0, 0);
    rx_poll(&x, x.go_at);
    rx_tap(&x, x.shown_at + 400, 0);
    CHECK_EQ(x.ms, 400);
    CHECK_EQ(x.best_ms, 150);
    /* the tick wraps after 49 days */
    rx_init(&x);
    rx_tap(&x, 0xFFFFFF00u, 0);
    CHECK(!rx_poll(&x, 0xFFFFFF10u));
    CHECK(rx_poll(&x, 0xFFFFFF00u + 1500));
    rx_tap(&x, 0xFFFFFF00u + 1500 + 300, 0);
    CHECK_EQ(x.ms, 300);
}

static void run(mz_t *m, int32_t gx, int32_t gy, uint32_t ms)
{
    for (uint32_t t = 0; t < ms; t += 33) mz_step(m, gx, gy, 33);
}
#define G(f) ((int32_t)((f) * MZ_G_COUNTS))

static void test_maze(void)
{
    mz_t m = { 0 };
    mz_reset(&m);
    CHECK(m.x == 26 && m.y == 26 && !m.won && !m.started);
    run(&m, 0, 0, 2000);                                             /* flat: it stays and the clock does not start */
    CHECK(m.x == 26 && m.y == 26 && !m.started && m.elapsed_ms == 0);
    run(&m, G(0.03), -G(0.03), 2000);                                /* inside the dead zone too */
    CHECK(m.x == 26 && m.y == 26);

    run(&m, G(0.3), 0, 3000);                                        /* right: stopped by the wall at x = 153 */
    CHECK(m.started && !m.won);
    CHECK(m.x > 138 && m.x <= 141.01f);
    CHECK(fabsf(m.y - 26) < 1);
    run(&m, G(-0.3), 0, 3000);                                       /* back left to the edge of the board */
    CHECK(m.x >= MZ_BALL_R && m.x < MZ_BALL_R + 1);
    run(&m, 0, G(0.3), 3000);                                        /* down: the wall under the first cells at y = 49 */
    CHECK(m.y > 30 && m.y <= 37.01f);
    CHECK(m.elapsed_ms > 8000 && m.elapsed_ms < 10000);

    /* the way through: right, down, left, down, right (a tilt of 0.35 g in every leg, a little of the other axis kept down) */
    mz_reset(&m);
    run(&m, G(0.35), 0, 3000);
    run(&m, 0, G(0.35), 3000);
    CHECK(m.y > 135 && m.y <= 141.01f && m.x > 120);                 /* stopped by the wall at y = 153 */
    run(&m, G(-0.35), 0, 3000);
    run(&m, 0, G(0.35), 3000);
    CHECK(m.y > 235);                                                /* down the left edge to the bottom row */
    CHECK(!m.won);
    run(&m, G(0.35), 0, 3000);
    CHECK(m.won);
    CHECK(m.x == 228 && m.y == 228);
    CHECK(m.best_ms == m.elapsed_ms && m.best_ms > 4000);
    uint32_t t = m.elapsed_ms;
    run(&m, G(-0.5), 0, 1000);                                       /* a won game stays won */
    CHECK(m.won && m.x == 228 && m.elapsed_ms == t);

    mz_reset(&m);                                                    /* again: the best time stays, a slower run does not replace it */
    CHECK(!m.won && m.x == 26 && m.elapsed_ms == 0 && m.best_ms == t);
    run(&m, G(0.35), 0, 3000);
    run(&m, 0, G(0.35), 1000);
    CHECK(m.best_ms == t);

    /* a huge tilt and a long stall never put the ball through a wall or out of the board */
    mz_reset(&m);
    for (int i = 0; i < 400; i++) mz_step(&m, G(2), G(-2), 5000);
    CHECK(m.x >= MZ_BALL_R && m.x <= MZ_SIZE - MZ_BALL_R && m.y >= MZ_BALL_R && m.y <= MZ_SIZE - MZ_BALL_R);
    for (unsigned i = 0; i < MZ_N_WALLS; i++) {
        const mz_wall_t *w = mz_wall(i);
        bool inside = m.x > w->x && m.x < w->x + w->w && m.y > w->y && m.y < w->y + w->h;
        CHECK(!inside);
    }
    mz_reset(&m);
    for (int i = 0; i < 400; i++) mz_step(&m, G(i % 2 ? 2 : -2), G(i % 3 ? 2 : -2), 5000);
    CHECK(m.x >= MZ_BALL_R && m.x <= MZ_SIZE - MZ_BALL_R && m.y >= MZ_BALL_R && m.y <= MZ_SIZE - MZ_BALL_R);
}

int main(void)
{
    test_ask();
    test_coin_and_dice();
    test_reaction();
    test_maze();
    return g_failed ? 1 : 0;
}
