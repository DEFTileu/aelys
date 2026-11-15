#include "games_core.h"
#include <math.h>

static const gm_answer_t answers[GM_N_ANSWERS] = {
    { "Yes, go for it", GM_YES }, { "Definitely", GM_YES }, { "I think so", GM_YES }, { "Looks good to me", GM_YES }, { "Why not?", GM_YES },
    { "Ask again later", GM_MAYBE }, { "Maybe", GM_MAYBE }, { "Hard to say", GM_MAYBE }, { "Let's see", GM_MAYBE },
    { "Not today", GM_NO }, { "Probably not", GM_NO }, { "I'd wait on that", GM_NO },
};

const gm_answer_t *gm_answer(unsigned i) { return &answers[i % GM_N_ANSWERS]; }

unsigned gm_ask_pick(unsigned last, uint32_t r)
{
    if (last >= GM_N_ANSWERS) return r % GM_N_ANSWERS;
    unsigned i = r % (GM_N_ANSWERS - 1); /* one fewer slot: the last answer is skipped */
    return i >= last ? i + 1 : i;
}

bool gm_coin_tails(uint32_t r) { return r >> 16 & 1; }

unsigned gm_die(uint32_t r) { return r % 6 + 1; } /* shortcut: 2^32 mod 6 != 0, a bias of one in a billion; nobody can see it */

unsigned gm_die_pips(unsigned face)
{
    static const uint8_t pips[7] = { 0, 1 << 3, 1 << 0 | 1 << 6, 1 << 0 | 1 << 3 | 1 << 6, 1 << 0 | 1 << 1 | 1 << 5 | 1 << 6,
                                     1 << 0 | 1 << 1 | 1 << 3 | 1 << 5 | 1 << 6, 1 << 0 | 1 << 1 | 1 << 2 | 1 << 4 | 1 << 5 | 1 << 6 };
    return pips[face > 6 ? 0 : face];
}

void rx_init(rx_t *x) { *x = (rx_t){ .st = RX_IDLE }; }

static void rx_start(rx_t *x, uint32_t now, uint32_t r)
{
    x->st = RX_WAIT;
    x->go_at = now + RX_MIN_WAIT_MS + r % (RX_SPAN_MS + 1);
}

uint32_t rx_wait_left(const rx_t *x, uint32_t now)
{
    uint32_t due = x->st == RX_WAIT ? x->go_at : x->st == RX_GO ? x->shown_at + RX_LIMIT_MS : now;
    return (int32_t)(due - now) > 0 ? due - now : 0;
}

bool rx_poll(rx_t *x, uint32_t now)
{
    if (x->st == RX_GO && now - x->shown_at >= RX_LIMIT_MS) { x->st = RX_SLOW; return true; }
    if (x->st != RX_WAIT || (int32_t)(now - x->go_at) < 0) return false;
    x->st = RX_GO;
    x->shown_at = now;
    return true;
}

void rx_tap(rx_t *x, uint32_t now, uint32_t r)
{
    if (x->st == RX_WAIT) {
        x->st = RX_EARLY;
    } else if (x->st == RX_GO && now - x->shown_at >= RX_LIMIT_MS) {
        x->st = RX_SLOW; /* the tap beat the timer that would have said so */
    } else if (x->st == RX_GO) {
        x->st = RX_DONE;
        x->ms = now - x->shown_at;
        if (!x->best_ms || x->ms < x->best_ms) x->best_ms = x->ms;
    } else {
        rx_start(x, now, r);
    }
}

/* Walls 6 px thick on the lines of a grid of 52 px cells: H(k, a, b) runs along line y = 52k from cell a to cell b, V(k, a, b) along x = 52k. */
#define H(k, a, b) { 52 * (a), 52 * (k) - 3, 52 * ((b) - (a)), 6 }
#define V(k, a, b) { 52 * (k) - 3, 52 * (a), 6, 52 * ((b) - (a)) }
/* Level 1 is the design's maze (right, down, left, down, right); 2-5 are spanning-tree mazes, picked for a longer way and more turns
 * each: 13, 15, 17, 19 and 23 cells, 6, 9, 11, 12 and 15 turns. test_games_core rolls the ball home through every one. */
static const struct { uint8_t n; mz_wall_t w[MZ_MAX_WALLS]; } levels[MZ_LEVELS] = {
    { 7, { H(1, 0, 2), V(3, 0, 2), H(2, 0, 2), H(3, 1, 5), V(2, 3, 4), V(4, 1, 3), H(4, 3, 5) } },
    { 11, { H(1, 0, 1), H(1, 4, 5), H(2, 2, 4), H(3, 1, 2), H(3, 3, 4), H(4, 0, 1), V(1, 1, 2), V(2, 0, 4), V(3, 1, 2), V(3, 3, 5), V(4, 3, 4) } },
    { 11, { H(1, 0, 3), H(2, 1, 2), H(2, 3, 4), H(3, 1, 4), H(4, 0, 1), H(4, 2, 3), V(2, 1, 2), V(2, 3, 4), V(3, 2, 3), V(4, 0, 2), V(4, 4, 5) } },
    { 9, { H(1, 1, 2), H(2, 0, 1), H(3, 1, 2), H(4, 0, 1), H(4, 3, 4), V(1, 0, 1), V(2, 1, 4), V(3, 1, 5), V(4, 0, 3) } },
    { 9, { H(1, 0, 1), H(1, 2, 3), H(2, 1, 2), H(2, 3, 4), H(3, 0, 1), H(4, 1, 3), V(2, 0, 4), V(3, 3, 4), V(4, 1, 5) } },
};
unsigned mz_n_walls(unsigned level) { return levels[level % MZ_LEVELS].n; }
const mz_wall_t *mz_wall(unsigned level, unsigned i) { return &levels[level % MZ_LEVELS].w[i % MZ_MAX_WALLS]; }

#define START_XY 26.0f    /* centre of the top-left cell */
#define GOAL_XY 228.0f    /* the goal ring (36 px at 210, 210) */
#define GOAL_R 24.0f      /* the ball touches the ring: rolling along the bottom row into the corner is enough */
#define ACC 900.0f        /* px/s^2 per g */
#define DEAD_G 0.04f      /* a board held about flat does not drift */
#define MAX_G 0.6f
#define MAX_V 260.0f
#define DAMP 1.2f         /* 1/s */
#define BOUNCE 0.25f
#define SUBSTEP_MS 5

void mz_reset(mz_t *m)
{
    if (m->open < 1 || m->open > MZ_LEVELS) m->open = 1;
    if (m->level >= m->open) m->level = 0;
    m->x = m->y = START_XY;
    m->vx = m->vy = 0;
    m->elapsed_ms = 0;
    m->started = m->won = false;
}

bool mz_set_level(mz_t *m, unsigned level)
{
    if (level >= m->open || level >= MZ_LEVELS) return false;
    m->level = (uint8_t)level;
    mz_reset(m);
    return true;
}

static float tilt_acc(int32_t g)
{
    float a = (float)g / MZ_G_COUNTS;
    float s = a < 0 ? -1.0f : 1.0f;
    a = fabsf(a);
    if (a <= DEAD_G) return 0;
    return s * (fminf(a, MAX_G) - DEAD_G) * ACC;
}

/* Push the ball out of the rectangle and take the speed that runs into it. */
static void push_out(mz_t *m, float rx, float ry, float rw, float rh)
{
    float cx = fminf(fmaxf(m->x, rx), rx + rw), cy = fminf(fmaxf(m->y, ry), ry + rh);
    float dx = m->x - cx, dy = m->y - cy, d2 = dx * dx + dy * dy, nx, ny, pen;
    if (d2 >= (float)(MZ_BALL_R * MZ_BALL_R)) return;
    if (d2 > 0.0001f) {
        float d = sqrtf(d2);
        nx = dx / d; ny = dy / d; pen = MZ_BALL_R - d;
    } else { /* the centre is inside (a very fast ball): out through the nearest side */
        float l = m->x - rx, r = rx + rw - m->x, t = m->y - ry, b = ry + rh - m->y, e = fminf(fminf(l, r), fminf(t, b));
        nx = e == l ? -1 : e == r ? 1 : 0; ny = nx ? 0 : e == t ? -1 : 1; pen = e + MZ_BALL_R;
    }
    m->x += nx * pen; m->y += ny * pen;
    float vn = m->vx * nx + m->vy * ny;
    if (vn < 0) { m->vx -= (1 + BOUNCE) * vn * nx; m->vy -= (1 + BOUNCE) * vn * ny; }
}

void mz_step(mz_t *m, int32_t gx, int32_t gy, uint32_t dt_ms)
{
    if (m->won) return;
    if (dt_ms > 50) dt_ms = 50; /* a stalled UI task must not fire the ball through a wall */
    float ax = tilt_acc(gx), ay = tilt_acc(gy);
    while (dt_ms) {
        uint32_t ms = dt_ms < SUBSTEP_MS ? dt_ms : SUBSTEP_MS;
        float dt = ms / 1000.0f;
        dt_ms -= ms;
        m->vx += ax * dt; m->vy += ay * dt;
        float k = 1.0f - DAMP * dt, sp = sqrtf(m->vx * m->vx + m->vy * m->vy);
        m->vx *= k; m->vy *= k;
        if (sp > MAX_V) { m->vx *= MAX_V / sp; m->vy *= MAX_V / sp; }
        m->x += m->vx * dt; m->y += m->vy * dt;
        const mz_wall_t *w = levels[m->level].w;
        for (unsigned i = 0; i < levels[m->level].n; i++) push_out(m, w[i].x, w[i].y, w[i].w, w[i].h);
        float lo = MZ_BALL_R, hi = MZ_SIZE - MZ_BALL_R;
        if (m->x < lo) { m->x = lo; if (m->vx < 0) m->vx *= -BOUNCE; }
        if (m->x > hi) { m->x = hi; if (m->vx > 0) m->vx *= -BOUNCE; }
        if (m->y < lo) { m->y = lo; if (m->vy < 0) m->vy *= -BOUNCE; }
        if (m->y > hi) { m->y = hi; if (m->vy > 0) m->vy *= -BOUNCE; }
        if (!m->started && fabsf(m->vx) + fabsf(m->vy) > 5.0f) m->started = true;
        if (m->started) m->elapsed_ms += ms;
        float gdx = m->x - GOAL_XY, gdy = m->y - GOAL_XY;
        if (gdx * gdx + gdy * gdy <= GOAL_R * GOAL_R) {
            m->won = true;
            m->x = m->y = GOAL_XY;
            m->vx = m->vy = 0;
            uint32_t *best = &m->best_ms[m->level];
            if (!*best || m->elapsed_ms < *best) *best = m->elapsed_ms;
            if (m->level + 1 < MZ_LEVELS && m->open < m->level + 2) m->open = (uint8_t)(m->level + 2);
            return;
        }
    }
}
