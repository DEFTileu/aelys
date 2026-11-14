#pragma once
/* Fake snapshot for screenshots and screen tests: the design's "Thu, Nov 12, 14:32" day. Made-up titles, no real data. */
#include <stdlib.h>
#include <string.h>
#include "ui.h"

#define FX_NOW 1794493920LL /* Thu 2026-11-12 14:32:00 UTC */
#define FX_H(h, m) (FX_NOW + ((h) - 14) * 3600LL + ((m) - 32) * 60LL)

static inline int64_t fx_clock(void) { return FX_NOW; }

static inline void fx_notice(snap_notice_t *n, const char *id, const char *kind, const char *title, int64_t created)
{
    memset(n, 0, sizeof *n);
    strcpy(n->id, id); strcpy(n->kind, kind); strcpy(n->title, title);
    n->created = created;
}

static inline void fx_snap(snap_t *s)
{
    memset(s, 0, sizeof *s);
    s->generated = FX_H(14, 5);
    s->has_task = true;
    strcpy(s->task.id, "t-101"); strcpy(s->task.title, "Ship pairing ADR"); s->task.due = FX_H(18, 0);
    s->has_event = true;
    strcpy(s->event.id, "e-22"); strcpy(s->event.title, "Design review");
    s->event.starts = FX_H(16, 0); s->event.ends = FX_H(16, 30); s->event.has_end = true;
    s->overdue = 0; s->unread = 3; s->other_unread = 2;
    s->today_done = 5; s->today_total = 8;
    s->n_notices = 3;
    fx_notice(&s->notices[0], "n-1", "task.reminder", "Ship pairing ADR", FX_NOW - 20);
    fx_notice(&s->notices[1], "n-2", "calendar.reminder", "Design review", FX_NOW - 15 * 60);
    fx_notice(&s->notices[2], "n-3", "focus.done", "Session done", FX_NOW - 20 * 60);
}

/* The v1.2 lists on top of fx_snap(): today's tasks (the first is the next task, one is overdue) and the events up to the end of tomorrow. */
static inline void fx_task(snap_task_t *t, const char *id, const char *title, int64_t due)
{
    memset(t, 0, sizeof *t);
    strcpy(t->id, id); strcpy(t->title, title); t->due = due;
}

static inline void fx_event(snap_event_t *e, const char *id, const char *title, int64_t starts, int64_t ends)
{
    memset(e, 0, sizeof *e);
    strcpy(e->id, id); strcpy(e->title, title); e->starts = starts; e->ends = ends; e->has_end = true;
}

static inline void fx_lists(snap_t *s)
{
    s->n_tasks = 5;
    fx_task(&s->tasks[0], "t-101", "Ship pairing ADR", FX_H(18, 0));
    fx_task(&s->tasks[1], "t-102", "Reply to Dana", FX_H(15, 30));
    fx_task(&s->tasks[2], "t-103", "Book dentist", FX_H(17, 0));
    fx_task(&s->tasks[3], "t-104", "Water the plants", FX_H(19, 30));
    fx_task(&s->tasks[4], "t-100", "Send invoice", FX_H(9, 0)); /* overdue */
    s->n_events = 4;
    fx_event(&s->events[0], "e-22", "Design review", FX_H(16, 0), FX_H(16, 30));
    fx_event(&s->events[1], "e-23", "Retro notes", FX_H(17, 30), FX_H(18, 0));
    fx_event(&s->events[2], "e-24", "Team sync", FX_H(33, 30), FX_H(34, 0));
    fx_event(&s->events[3], "e-25", "Dentist", FX_H(35, 0), FX_H(36, 0));
}

/* The v1.3 weather on top of fx_snap(): snowing, the next five hours. */
static inline void fx_weather(snap_t *s)
{
    s->weather = (snap_weather_t){ .updated = FX_NOW - 5 * 60, .present = true, .temp = -3, .hi = -1, .lo = -8, .code = 71, .n_hours = 5,
                                   .hours = { { 15, 71, -4 }, { 16, 3, -5 }, { 17, 3, -6 }, { 18, 2, -7 }, { 19, 0, -8 } } };
}

/* publish into ui_snap_tb and tell the UI */
static inline void fx_post(const snap_t *s, uint8_t live)
{
    *(snap_t *)tribuf_back(&ui_snap_tb) = *s;
    tribuf_publish(&ui_snap_tb);
    ui_event_t ev = { .type = UI_EV_SNAPSHOT, .len = 1, .data = { live } };
    ui_handle_event(&ev);
}
