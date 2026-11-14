#pragma once
/* Timing of the Timer and Stopwatch screens. Pure C: no LVGL and no clock of its own; `now` is a monotonic millisecond tick
 * (lv_tick_get()). Every difference is unsigned or int32, so the 32-bit tick wrapping after 49 days does no harm. */
#include <stdbool.h>
#include <stdint.h>

typedef enum { TMR_SET, TMR_RUN, TMR_PAUSED, TMR_DONE } tmr_state_t;
typedef struct {
    tmr_state_t st;
    uint32_t preset_ms; /* what "Set" counts from; a reset goes back to it */
    uint32_t total_ms;  /* this run (preset, or 60 s after a +1 min); the ring's full circle */
    uint32_t left_ms;   /* frozen unless RUN */
    uint32_t end_ms;    /* RUN: the tick at which it ends */
} tmr_t;

void tmr_init(tmr_t *t, uint32_t preset_ms);
void tmr_set_preset(tmr_t *t, uint32_t preset_ms);     /* SET only */
uint32_t tmr_left_ms(const tmr_t *t, uint32_t now);    /* SET: the preset; DONE: 0 */
void tmr_toggle(tmr_t *t, uint32_t now);               /* SET -> RUN, RUN -> PAUSED, PAUSED -> RUN; DONE: nothing */
bool tmr_poll(tmr_t *t, uint32_t now);                 /* RUN -> DONE once the time is up; true exactly on that change */
void tmr_add_minute(tmr_t *t, uint32_t now);           /* DONE -> RUN for one more minute; else nothing */
void tmr_reset(tmr_t *t);                              /* any state -> SET with the preset */

#define SW_LAPS 3 /* the last laps kept */
typedef struct {
    bool running;
    uint32_t base_ms; /* elapsed while stopped */
    uint32_t t0;      /* tick of the last start */
    uint32_t mark_ms; /* elapsed at the last lap */
    uint32_t n_laps;
    uint32_t lap_ms[SW_LAPS]; /* length of each lap, newest first */
} sw_t;

uint32_t sw_elapsed_ms(const sw_t *s, uint32_t now);
void sw_toggle(sw_t *s, uint32_t now);                 /* start / stop */
bool sw_lap(sw_t *s, uint32_t now);                    /* only while running; false otherwise */
bool sw_reset(sw_t *s);                                /* only while stopped; false otherwise */
