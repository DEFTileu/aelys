#include "gesture.h"

#define TAP_MS 400
#define TAP_MOVE_PX 20
#define SWIPE_MS 600
#define SWIPE_MIN_PX 60
#define CLICK_MS 500

gesture_t gesture_feed(gesture_ctx_t *g, bool touched, int16_t x, int16_t y, uint32_t now_ms)
{
    if (touched) {
        if (!g->down) { g->down = true; g->x0 = x; g->y0 = y; g->t0 = now_ms; }
        g->x = x;
        g->y = y;
        return GEST_NONE;
    }
    if (!g->down) return GEST_NONE;
    g->down = false;
    uint32_t dt = now_ms - g->t0;
    int dx = g->x - g->x0, dy = g->y - g->y0;
    int adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
    if (dt <= TAP_MS && dx * dx + dy * dy < TAP_MOVE_PX * TAP_MOVE_PX) return GEST_TAP;
    if (dt <= SWIPE_MS && adx >= SWIPE_MIN_PX && adx >= 2 * ady) return dx < 0 ? GEST_SWIPE_LEFT : GEST_SWIPE_RIGHT;
    return GEST_NONE;
}

ui_btn_t btn_feed(btn_ctx_t *b, bool top, bool low, uint32_t now_ms)
{
    ui_btn_t out = 0;
    bool was = b->top || b->low, now = top || low;
    if (top && low) b->tainted = true;
    if (!was && now) b->t0 = now_ms;
    if (was && !now) {
        if (!b->tainted && now_ms - b->t0 <= CLICK_MS) out = b->top ? BTN_TOP : BTN_LOW;
        b->tainted = false;
    }
    b->top = top;
    b->low = low;
    return out;
}

bool gesture_moved(const gesture_ctx_t *g)
{
    int dx = g->x - g->x0, dy = g->y - g->y0;
    return g->down && dx * dx + dy * dy >= TAP_MOVE_PX * TAP_MOVE_PX;
}

bool debounce_feed(debounce_t *d, bool raw)
{
    if (raw == d->level) d->n = 0;
    else if (++d->n >= 3) { d->level = raw; d->n = 0; }
    return d->level;
}
