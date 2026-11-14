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

/* Reaction: wait 1.5 to 4 s, the screen turns, tap as fast as possible. */
#define RX_MIN_WAIT_MS 1500
#define RX_SPAN_MS 2500
typedef enum { RX_IDLE, RX_WAIT, RX_GO, RX_DONE, RX_EARLY } rx_state_t;
typedef struct {
    rx_state_t st;
    uint32_t go_at;    /* WAIT: the tick at which the screen turns */
    uint32_t shown_at; /* GO: the tick at which it did */
    uint32_t ms;       /* DONE: this reaction */
    uint32_t best_ms;  /* the best of the session, 0 = none yet */
} rx_t;
void rx_init(rx_t *x);
uint32_t rx_wait_left(const rx_t *x, uint32_t now);        /* WAIT: ms until the screen turns, else 0 */
bool rx_poll(rx_t *x, uint32_t now);                       /* WAIT -> GO once due; true exactly on that change */
void rx_tap(rx_t *x, uint32_t now, uint32_t r);            /* WAIT: too soon; GO: the time; anything else starts a new wait */

/* Tilt maze on a 260 x 260 board (design "Лабиринт наклоном"): the ball rolls with the tilt, walls stop it, the goal is in the far corner. */
#define MZ_SIZE 260
#define MZ_BALL_R 12
#define MZ_G_COUNTS 16384 /* one g in accelerometer counts (+-2 g, 16 bit) */
typedef struct { int16_t x, y, w, h; } mz_wall_t;
#define MZ_N_WALLS 7
const mz_wall_t *mz_wall(unsigned i);
typedef struct {
    float x, y, vx, vy;  /* ball centre and speed, board px and px/s */
    uint32_t elapsed_ms; /* from the first movement */
    bool started, won;
    uint32_t best_ms;    /* 0 = none yet */
} mz_t;
void mz_reset(mz_t *m);                                    /* ball back at the start, the best time kept */
/* gx, gy: gravity along the screen axes (x right, y down) in counts. */
void mz_step(mz_t *m, int32_t gx, int32_t gy, uint32_t dt_ms);
