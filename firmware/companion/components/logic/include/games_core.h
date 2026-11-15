#pragma once
/* Rules of the Games app. Pure C: no LVGL, no clock and no random source of its own. `now` is a monotonic millisecond tick
 * (lv_tick_get(), wrap-safe), `r` is a random 32-bit value the caller draws (esp_random() on the board, a script in host tests). */
#include <stdbool.h>
#include <stdint.h>

/* Ask Aelys: a short friendly answer. */
#define GM_N_ANSWERS 12
typedef enum { GM_YES, GM_MAYBE, GM_NO } gm_tone_t;
typedef struct { const char *text; gm_tone_t tone; } gm_answer_t;
const gm_answer_t *gm_answer(unsigned i);                  /* i < GM_N_ANSWERS */
unsigned gm_ask_pick(unsigned last, uint32_t r);           /* never the same answer twice in a row; last >= GM_N_ANSWERS = none yet */

/* Coin and dice. */
bool gm_coin_tails(uint32_t r);
unsigned gm_die(uint32_t r);                               /* 1..6 */
/* Pips of a face as a bit mask over the seven spots: 0 top-left, 1 top-right, 2 mid-left, 3 centre, 4 mid-right, 5 bottom-left, 6 bottom-right. */
unsigned gm_die_pips(unsigned face);

/* Reaction: wait 1.5 to 4 s, the screen turns, tap as fast as possible; no tap within 2 s is "too slow". */
#define RX_MIN_WAIT_MS 1500
#define RX_SPAN_MS 2500
#define RX_LIMIT_MS 2000
typedef enum { RX_IDLE, RX_WAIT, RX_GO, RX_DONE, RX_EARLY, RX_SLOW } rx_state_t;
typedef struct {
    rx_state_t st;
    uint32_t go_at;    /* WAIT: the tick at which the screen turns */
    uint32_t shown_at; /* GO: the tick at which it did */
    uint32_t ms;       /* DONE: this reaction */
    uint32_t best_ms;  /* the best so far (kept across reboots by the UI), 0 = none yet */
} rx_t;
void rx_init(rx_t *x);
uint32_t rx_wait_left(const rx_t *x, uint32_t now);        /* WAIT: ms until the screen turns; GO: until too slow; else 0 */
bool rx_poll(rx_t *x, uint32_t now);                       /* WAIT -> GO, GO -> SLOW once due; true exactly on a change */
void rx_tap(rx_t *x, uint32_t now, uint32_t r);            /* WAIT: too soon; GO: the time (or too slow); anything else starts a new wait */

/* Tilt maze on a 260 x 260 board (design "Лабиринт наклоном"): the ball rolls with the tilt, walls stop it, the goal is in the far corner.
 * Five levels on a grid of 52 px cells, each a longer way home; winning one opens the next. */
#define MZ_SIZE 260
#define MZ_BALL_R 12
#define MZ_G_COUNTS 16384 /* one g in accelerometer counts (+-2 g, 16 bit) */
#define MZ_LEVELS 5
#define MZ_MAX_WALLS 11
typedef struct { int16_t x, y, w, h; } mz_wall_t;
unsigned mz_n_walls(unsigned level);                       /* level < MZ_LEVELS */
const mz_wall_t *mz_wall(unsigned level, unsigned i);      /* i < mz_n_walls(level) */
typedef struct {
    float x, y, vx, vy;  /* ball centre and speed, board px and px/s */
    uint32_t elapsed_ms; /* from the first movement */
    bool started, won;
    uint8_t level;       /* 0-based, < open */
    uint8_t open;        /* levels open to play, 1..MZ_LEVELS */
    uint32_t best_ms[MZ_LEVELS]; /* 0 = none yet */
} mz_t;
void mz_reset(mz_t *m);                                    /* ball back at the start of the same level; level, open levels and best times kept */
bool mz_set_level(mz_t *m, unsigned level);                /* an open level: reset there and true; otherwise nothing and false */
/* gx, gy: gravity along the screen axes (x right, y down) in counts. A win keeps the best time of the level and opens the next one. */
void mz_step(mz_t *m, int32_t gx, int32_t gy, uint32_t dt_ms);

/* What the board remembers of the games across reboots (NVS key "games", store_codec). */
typedef struct {
    uint32_t rx_best_ms;
    uint8_t mz_level, mz_open;
    uint32_t mz_best_ms[MZ_LEVELS];
} game_rec_t;
