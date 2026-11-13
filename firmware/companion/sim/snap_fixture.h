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

/* publish into ui_snap_tb and tell the UI */
static inline void fx_post(const snap_t *s, uint8_t live)
{
    *(snap_t *)tribuf_back(&ui_snap_tb) = *s;
    tribuf_publish(&ui_snap_tb);
    ui_event_t ev = { .type = UI_EV_SNAPSHOT, .len = 1, .data = { live } };
    ui_handle_event(&ev);
}
