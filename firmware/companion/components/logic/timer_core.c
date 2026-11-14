#include <string.h>
#include "timer_core.h"

#define MINUTE_MS 60000u

void tmr_init(tmr_t *t, uint32_t preset_ms)
{
    memset(t, 0, sizeof *t);
    t->st = TMR_SET;
    t->preset_ms = t->total_ms = t->left_ms = preset_ms;
}

void tmr_set_preset(tmr_t *t, uint32_t preset_ms)
{
    if (t->st == TMR_SET) t->preset_ms = t->total_ms = t->left_ms = preset_ms;
}

uint32_t tmr_left_ms(const tmr_t *t, uint32_t now)
{
    if (t->st == TMR_DONE) return 0;
    if (t->st != TMR_RUN) return t->left_ms;
    int32_t d = (int32_t)(t->end_ms - now);
    return d > 0 ? (uint32_t)d : 0;
}

void tmr_toggle(tmr_t *t, uint32_t now)
{
    if (t->st == TMR_RUN) {
        t->left_ms = tmr_left_ms(t, now);
        t->st = TMR_PAUSED;
    } else if ((t->st == TMR_SET || t->st == TMR_PAUSED) && t->left_ms > 0) {
        t->end_ms = now + t->left_ms;
        t->st = TMR_RUN;
    }
}

bool tmr_poll(tmr_t *t, uint32_t now)
{
    if (t->st != TMR_RUN || tmr_left_ms(t, now) > 0) return false;
    t->st = TMR_DONE;
    t->left_ms = 0;
    return true;
}

void tmr_add_minute(tmr_t *t, uint32_t now)
{
    if (t->st != TMR_DONE) return;
    t->total_ms = t->left_ms = MINUTE_MS;
    t->end_ms = now + MINUTE_MS;
    t->st = TMR_RUN;
}

void tmr_reset(tmr_t *t) { tmr_init(t, t->preset_ms); }

uint32_t sw_elapsed_ms(const sw_t *s, uint32_t now) { return s->base_ms + (s->running ? now - s->t0 : 0); }

void sw_toggle(sw_t *s, uint32_t now)
{
    if (s->running) s->base_ms = sw_elapsed_ms(s, now);
    else s->t0 = now;
    s->running = !s->running;
}

bool sw_lap(sw_t *s, uint32_t now)
{
    if (!s->running) return false;
    uint32_t e = sw_elapsed_ms(s, now);
    memmove(&s->lap_ms[1], &s->lap_ms[0], (SW_LAPS - 1) * sizeof s->lap_ms[0]);
    s->lap_ms[0] = e - s->mark_ms;
    s->mark_ms = e;
    s->n_laps++;
    return true;
}

bool sw_reset(sw_t *s)
{
    if (s->running) return false;
    memset(s, 0, sizeof *s);
    return true;
}
