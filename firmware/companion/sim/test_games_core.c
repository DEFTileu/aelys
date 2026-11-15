#include <math.h>
#include <stdio.h>
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
    CHECK_EQ(rx_wait_left(&x, 2600), 1900);                          /* then the 2 s limit runs */
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
    /* no tap for 2 s: too slow, the best stays; the next tap starts again */
    rx_tap(&x, 0, 0);
    rx_poll(&x, x.go_at);
    CHECK(!rx_poll(&x, x.shown_at + RX_LIMIT_MS - 1));
    CHECK(rx_poll(&x, x.shown_at + RX_LIMIT_MS));
    CHECK_EQ(x.st, RX_SLOW);
    CHECK_EQ(rx_wait_left(&x, x.shown_at + RX_LIMIT_MS), 0);
    CHECK(!rx_poll(&x, x.shown_at + 99999));
    CHECK_EQ(x.best_ms, 150);
    rx_tap(&x, 50000, 0);
    CHECK_EQ(x.st, RX_WAIT);
    /* a late tap that beats the timer is too slow as well, not a 2.5 s time */
    rx_poll(&x, x.go_at);
    rx_tap(&x, x.shown_at + 2500, 0);
    CHECK_EQ(x.st, RX_SLOW);
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
    CHECK(m.best_ms[0] == m.elapsed_ms && m.best_ms[0] > 4000);
    CHECK(m.open == 2 && m.level == 0);                              /* the win opened level 2 */
    uint32_t t = m.elapsed_ms;
    run(&m, G(-0.5), 0, 1000);                                       /* a won game stays won */
    CHECK(m.won && m.x == 228 && m.elapsed_ms == t);

    mz_reset(&m);                                                    /* again: the best time stays, a slower run does not replace it */
    CHECK(!m.won && m.x == 26 && m.elapsed_ms == 0 && m.best_ms[0] == t && m.open == 2);
    run(&m, G(0.35), 0, 3000);
    run(&m, 0, G(0.35), 1000);
    CHECK(m.best_ms[0] == t);

    /* a huge tilt and a long stall never put the ball through a wall or out of the board */
    mz_reset(&m);
    for (int i = 0; i < 400; i++) mz_step(&m, G(2), G(-2), 5000);
    CHECK(m.x >= MZ_BALL_R && m.x <= MZ_SIZE - MZ_BALL_R && m.y >= MZ_BALL_R && m.y <= MZ_SIZE - MZ_BALL_R);
    for (unsigned i = 0; i < m.n_walls; i++) {
        const mz_wall_t *w = &m.walls[i];
        bool inside = m.x > w->x && m.x < w->x + w->w && m.y > w->y && m.y < w->y + w->h;
        CHECK(!inside);
    }
    mz_reset(&m);
    for (int i = 0; i < 400; i++) mz_step(&m, G(i % 2 ? 2 : -2), G(i % 3 ? 2 : -2), 5000);
    CHECK(m.x >= MZ_BALL_R && m.x <= MZ_SIZE - MZ_BALL_R && m.y >= MZ_BALL_R && m.y <= MZ_SIZE - MZ_BALL_R);
}

static int line_at(unsigned n, unsigned k) { return (int)(k * MZ_SIZE / n); }

/* Cells (x, y) of the built level are joined unless a wall covers the middle of the side they share. */
static bool joined(const mz_t *m, int x0, int y0, int x1, int y1)
{
    unsigned n = m->grid;
    int mx = x1 != x0 ? line_at(n, x0 > x1 ? x0 : x1) : (line_at(n, x0) + line_at(n, x0 + 1)) / 2;
    int my = y1 != y0 ? line_at(n, y0 > y1 ? y0 : y1) : (line_at(n, y0) + line_at(n, y0 + 1)) / 2;
    for (unsigned i = 0; i < m->n_walls; i++) {
        const mz_wall_t *w = &m->walls[i];
        if (mx >= w->x && mx <= w->x + w->w && my >= w->y && my <= w->y + w->h) return false;
    }
    return true;
}

/* The way home through the cells (breadth first), the top-left cell to the bottom-right one; returns its length, 0 if there is none. */
static int way_home(const mz_t *m, int way[49])
{
    int n = m->grid, last = n * n - 1, prev[49], q[49], len = 0, h = 0, t = 0;
    for (int i = 0; i < 49; i++) prev[i] = -1;
    prev[0] = 0; q[t++] = 0;
    while (h < t) {
        int c = q[h++], x = c % n, y = c / n;
        const int d[4][2] = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } };
        for (int k = 0; k < 4; k++) {
            int X = x + d[k][0], Y = y + d[k][1];
            if (X < 0 || X >= n || Y < 0 || Y >= n || prev[Y * n + X] >= 0 || !joined(m, x, y, X, Y)) continue;
            prev[Y * n + X] = c; q[t++] = Y * n + X;
        }
    }
    if (prev[last] < 0) return 0;
    for (int c = last; c; c = prev[c]) way[len++] = c;
    way[len++] = 0;
    for (int i = 0; i < len / 2; i++) { int tmp = way[i]; way[i] = way[len - 1 - i]; way[len - 1 - i] = tmp; }
    return len;
}

/* Every level can be won by a hand on the tilt, one after the other (each win opens the next): steer the ball from cell centre to cell
 * centre along the way home, never over 0.6 g. */
static void test_maze_levels(void)
{
    static const int drawn[MZ_FIXED_LEVELS] = { 13, 15, 17, 19, 23 };
    mz_t m = { 0 };
    mz_reset(&m);
    CHECK(m.open == 1 && m.level == 0 && m.grid == 5 && m.ball_r == MZ_BALL_R);
    CHECK(!mz_set_level(&m, 1) && m.level == 0);                     /* a closed level does not open */
    int longest5 = 0;
    for (unsigned lv = 0; lv < MZ_LEVELS; lv++) {
        CHECK(mz_set_level(&m, lv));
        CHECK_EQ(m.grid, lv < 15 ? 5 : lv < 30 ? 6 : 7);              /* 5 x 5 to level 15, 6 x 6 to 30, then 7 x 7 */
        CHECK(m.n_walls <= MZ_MAX_WALLS && m.n_walls > 0);
        CHECK(m.x == m.start_xy && m.y == m.start_xy && !m.won);
        int way[49], len = way_home(&m, way);
        CHECK(len > 0);                                              /* there is a way home */
        if (lv >= MZ_FIXED_LEVELS) {                                 /* a generated maze is a tree: n*n - 1 open sides join every cell */
            int sides = 0, g = m.grid;
            for (int c = 0; c < g * g; c++) {
                if (c % g + 1 < g) sides += joined(&m, c % g, c / g, c % g + 1, c / g);
                if (c / g + 1 < g) sides += joined(&m, c % g, c / g, c % g, c / g + 1);
            }
            CHECK_EQ(sides, g * g - 1);
        }
        if (lv < MZ_FIXED_LEVELS) CHECK_EQ(len, drawn[lv]);
        else if (m.grid == 5 && len > longest5) longest5 = len;
        int n = m.grid, next = 1;
        for (uint32_t t = 0; t < 180000 && !m.won; t += 33) {
            float tx = (line_at(n, way[next] % n) + line_at(n, way[next] % n + 1)) / 2.0f;
            float ty = (line_at(n, way[next] / n) + line_at(n, way[next] / n + 1)) / 2.0f;
            float ax = (tx - m.x) * 20 - m.vx * 8, ay = (ty - m.y) * 20 - m.vy * 8; /* px/s^2 wanted */
            float lim = 0.6f * 900;
            ax = ax > lim ? lim : ax < -lim ? -lim : ax;
            ay = ay > lim ? lim : ay < -lim ? -lim : ay;
            mz_step(&m, (int32_t)(ax / 900 * MZ_G_COUNTS), (int32_t)(ay / 900 * MZ_G_COUNTS), 33);
            if (next < len - 1 && fabsf(tx - m.x) < 8 && fabsf(ty - m.y) < 8) next++;
        }
        CHECK(m.won);
        if (!m.won) printf("level %u: stuck at %.0f, %.0f heading to cell %d\n", lv + 1, m.x, m.y, way[next]);
        if (lv < MZ_FIXED_LEVELS) CHECK(m.best_ms[lv] == m.elapsed_ms && m.best_ms[lv] > 0);
        CHECK_EQ(m.open, lv + 2 <= MZ_LEVELS ? lv + 2 : MZ_LEVELS);  /* the next level opened; the last one opens nothing */
    }
    CHECK(longest5 > 15);                                            /* the generated 5 x 5 levels reach longer ways than level 2 */
    CHECK(!mz_set_level(&m, MZ_LEVELS));

    /* a level number always gives the same maze */
    mz_set_level(&m, 40);
    mz_wall_t first[MZ_MAX_WALLS];
    unsigned nw = m.n_walls;
    memcpy(first, m.walls, sizeof first);
    mz_set_level(&m, 41);
    CHECK(m.n_walls != nw || memcmp(first, m.walls, nw * sizeof *first));   /* the next one differs */
    mz_set_level(&m, 40);
    CHECK(m.n_walls == nw && !memcmp(first, m.walls, nw * sizeof *first));

    mz_set_level(&m, 2);                                             /* an earlier level keeps its best and the others' */
    CHECK(m.level == 2 && m.open == MZ_LEVELS && m.best_ms[4] > 0);
    m.level = 120; m.open = 200;                                     /* nonsense (a bad blob) falls back to level 1 */
    mz_reset(&m);
    CHECK(m.level == 0 && m.open == 1 && m.grid == 5);
}

int main(void)
{
    test_ask();
    test_coin_and_dice();
    test_reaction();
    test_maze();
    test_maze_levels();
    return g_failed ? 1 : 0;
}
