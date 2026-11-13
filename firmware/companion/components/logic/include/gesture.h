#pragma once
/* Touch gestures and key clicks from raw samples. Pure C, no IDF. */
#include <stdbool.h>
#include <stdint.h>
#include "ui_events.h"

typedef enum { GEST_NONE, GEST_TAP, GEST_SWIPE_LEFT, GEST_SWIPE_RIGHT } gesture_t;
typedef struct { bool down; int16_t x0, y0, x, y; uint32_t t0; } gesture_ctx_t;

/* Call on every poll with the finger state; the gesture is returned once, on the poll that sees the lift (x, y are
 * ignored then). Tap: lifted within 400 ms and moved < 20 px. Swipe: within 600 ms, |dx| >= 60 px and |dx| >= 2|dy|;
 * SWIPE_RIGHT = the finger moved right. Anything else (a hold, a slow or vertical drag) is GEST_NONE. */
gesture_t gesture_feed(gesture_ctx_t *g, bool touched, int16_t x, int16_t y, uint32_t now_ms);

/* One side key pressed and released within 500 ms while the other was never down since both were up (so the
 * two-key combo never started) is a click: returns BTN_TOP / BTN_LOW at the release, else 0. */
typedef struct { bool top, low, tainted; uint32_t t0; } btn_ctx_t;
ui_btn_t btn_feed(btn_ctx_t *b, bool top, bool low, uint32_t now_ms);

/* The finger is down and has moved 20 px or more from where it landed: not a tap, and not a hold either. */
bool gesture_moved(const gesture_ctx_t *g);

/* Switch debounce: the returned level changes only after 3 polls in a row that disagree with it. */
typedef struct { bool level; uint8_t n; } debounce_t;
bool debounce_feed(debounce_t *d, bool raw);
