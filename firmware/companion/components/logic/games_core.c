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
    return x->st == RX_WAIT && (int32_t)(x->go_at - now) > 0 ? x->go_at - now : 0;
}

bool rx_poll(rx_t *x, uint32_t now)
{
    if (x->st != RX_WAIT || (int32_t)(now - x->go_at) < 0) return false;
    x->st = RX_GO;
    x->shown_at = now;
    return true;
}

void rx_tap(rx_t *x, uint32_t now, uint32_t r)
{
    if (x->st == RX_WAIT) {
        x->st = RX_EARLY;
    } else if (x->st == RX_GO) {
        x->st = RX_DONE;
        x->ms = now - x->shown_at;
        if (!x->best_ms || x->ms < x->best_ms) x->best_ms = x->ms;
    } else {
        rx_start(x, now, r);
    }
}

/* The design's walls, 6 px thick, on a grid of 52 px cells: the way from the top-left cell to the goal runs right, down, left, down, right. */
static const mz_wall_t walls[MZ_N_WALLS] = {
    { 0, 49, 104, 6 }, { 153, 0, 6, 104 }, { 0, 101, 104, 6 }, { 52, 153, 208, 6 }, { 101, 156, 6, 52 }, { 205, 52, 6, 104 }, { 156, 205, 104, 6 },
};
const mz_wall_t *mz_wall(unsigned i) { return &walls[i % MZ_N_WALLS]; }

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
    *m = (mz_t){ .x = START_XY, .y = START_XY, .best_ms = m->best_ms };
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
        for (unsigned i = 0; i < MZ_N_WALLS; i++) push_out(m, walls[i].x, walls[i].y, walls[i].w, walls[i].h);
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
            if (!m->best_ms || m->elapsed_ms < m->best_ms) m->best_ms = m->elapsed_ms;
            return;
        }
    }
}
