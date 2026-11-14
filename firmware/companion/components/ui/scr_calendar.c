/* Calendar (design "Календарь · следующее"): the next event large, a coral ring that fills over the last 60 minutes before it starts
 * (full once it has started), the relative line on top ("in 25 min", "now", "started 10 min ago"), the title (up to 3 lines) and
 * "16:00 - 17:00" or "All day". With the server's events_upcoming (v1.2) the title is cut to 2 lines and up to 3 more upcoming
 * events follow as rows (time, title), a "Tomorrow" label above the first one that is tomorrow's; events that already ended are left out
 * of the rows (and the first one still to come is the large one). Without the list (older server) it is the one-event view.
 * render() runs once a second for the visible screen and only changed labels or ring steps redraw: the text moves once a minute,
 * once a second in the last minute before the start.
 * Deviations: the relative line is not upper-cased and not letter-spaced; no location after the time (the snapshot has none);
 * a plain hyphen between the times (the fonts have no en dash). */
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "ui_screens_priv.h"

#define TEXT_W 280
#define RING_WINDOW_S 3600
#define COLOR_EVENT 0xFF8A84
#define COLOR_EVENT_TRACK 0x2A1618
#define ROWS (SNAP_MAX_EVENTS - 1)
#define ROW_W 300
#define ROW_H 34
#define TIME_W 66

static struct {
    lv_obj_t *root, *eb, *title, *when, *head;
    struct { lv_obj_t *row, *time, *title; } r[ROWS];
    ui_arc_t ring;
} c;

/* Does epoch t fall on the local day after now's? Needs the clock (now > 0). */
static bool is_tomorrow(int64_t t, int64_t now)
{
    time_t a = (time_t)now, b = (time_t)t;
    struct tm today, then;
    if (now <= 0 || t <= 0 || !localtime_r(&a, &today) || !localtime_r(&b, &then)) return false;
    today.tm_mday += 1;
    today.tm_isdst = -1;
    if (mktime(&today) == (time_t)-1) return false; /* normalises to tomorrow's date */
    return then.tm_year == today.tm_year && then.tm_yday == today.tm_yday;
}

static bool ended(const snap_event_t *e, int64_t now)
{
    return now > 0 && (e->has_end ? now >= e->ends : now >= e->starts + 3600);
}

/* "45 s", "25 min", "2 h 5 min", "2 h", "3 d" */
static void span(char *out, size_t n, int64_t s)
{
    if (s < 60) snprintf(out, n, "%d s", (int)s);
    else if (s < 3600) snprintf(out, n, "%d min", (int)(s / 60));
    else if (s < 86400) {
        int h = (int)(s / 3600), m = (int)(s % 3600 / 60);
        if (m) snprintf(out, n, "%d h %d min", h, m);
        else snprintf(out, n, "%d h", h);
    } else snprintf(out, n, "%d d", (int)(s / 86400));
}

void scr_calendar_set(const snap_t *s, int64_t now)
{
    char eb[40] = "", title[65] = "", when[32] = "", sp[24];
    uint32_t title_color = UI_COLOR_TEXT;
    int pct = 0;
    bool ring = false;
    const snap_event_t *e = NULL, *rows[ROWS];
    int n_rows = 0;
    if (s->n_events > 0) {
        int first = 0;
        while (first < s->n_events - 1 && ended(&s->events[first], now)) first++;
        e = &s->events[first];
        for (int i = first + 1; i < s->n_events && n_rows < ROWS; i++)
            if (!ended(&s->events[i], now)) rows[n_rows++] = &s->events[i];
    } else if (s->has_event) e = &s->event;
    bool big_tomorrow = e && is_tomorrow(e->starts, now);
    if (e) {
        snprintf(title, sizeof title, "%s", e->title);
        if (e->all_day) {
            snprintf(when, sizeof when, "All day");
            if (now > 0) snprintf(eb, sizeof eb, big_tomorrow ? "Tomorrow" : "Today");
        } else {
            char a[8], b[8];
            ui_fmt_hm(a, e->starts);
            if (e->has_end) { ui_fmt_hm(b, e->ends); snprintf(when, sizeof when, "%s - %s", a, b); }
            else snprintf(when, sizeof when, "%s", a);
            if (now > 0) {
                int64_t until = e->starts - now;
                ring = true;
                if (until > 0) {
                    span(sp, sizeof sp, until);
                    snprintf(eb, sizeof eb, "in %s", sp);
                    pct = until >= RING_WINDOW_S ? 0 : (int)((RING_WINDOW_S - until) * 100 / RING_WINDOW_S);
                } else {
                    pct = 100;
                    if (e->has_end && now >= e->ends) {
                        if (now - e->ends < 60) snprintf(eb, sizeof eb, "just ended");
                        else { span(sp, sizeof sp, now - e->ends); snprintf(eb, sizeof eb, "ended %s ago", sp); }
                    } else if (-until < 60) {
                        snprintf(eb, sizeof eb, "now");
                    } else {
                        span(sp, sizeof sp, -until);
                        snprintf(eb, sizeof eb, "started %s ago", sp);
                    }
                }
            }
        }
    } else {
        title_color = UI_COLOR_MUTED;
        snprintf(title, sizeof title, "%s", s->generated > 0 ? "No more events today" : "No data yet");
    }
    ui_set_text(c.eb, eb);
    lv_obj_set_hidden(c.eb, !eb[0]);
    ui_set_text(c.title, title);
    ui_text_color(c.title, title_color);
    lv_obj_set_height(c.title, ui_text_height(title, &inter_28, TEXT_W, n_rows ? 2 : 3));
    ui_set_text(c.when, when);
    lv_obj_set_hidden(c.when, !when[0]);
    lv_obj_set_hidden(c.ring.obj, !ring);
    ui_arc_set(&c.ring, pct, COLOR_EVENT, COLOR_EVENT_TRACK);

    lv_obj_t *col[3 + 1 + ROWS] = { c.eb, c.title, c.when };
    uint8_t gap[3 + 1 + ROWS] = { 0, 6, 8 };
    int n = 3;
    bool head = false;
    for (int i = 0; i < ROWS; i++) {
        lv_obj_set_hidden(c.r[i].row, i >= n_rows);
        if (i >= n_rows) continue;
        const snap_event_t *k = rows[i];
        if (!head && !big_tomorrow && is_tomorrow(k->starts, now)) { /* the first of tomorrow's: a label above it */
            head = true;
            col[n] = c.head; gap[n++] = 14;
        }
        char tm[8];
        if (k->all_day) snprintf(tm, sizeof tm, "All day"); else ui_fmt_hm(tm, k->starts);
        ui_set_text(c.r[i].time, tm);
        ui_set_text(c.r[i].title, k->title);
        gap[n] = n == 3 ? 14 : col[n - 1] == c.head ? 2 : 0; /* 14 after the big block; tight under a label or another row */
        col[n++] = c.r[i].row;
    }
    lv_obj_set_hidden(c.head, !head);
    ui_stack(col, gap, n, 0, UI_SCREEN_SIZE, -1);
}

lv_obj_t *scr_calendar_create(lv_obj_t *parent)
{
    c.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    ui_arc_create(&c.ring, c.root);
    lv_obj_set_hidden(c.ring.obj, true);
    c.eb = ui_label(c.root, &inter_16, COLOR_EVENT, 260, 1, LV_TEXT_ALIGN_CENTER);
    c.title = ui_label(c.root, &inter_28, UI_COLOR_TEXT, TEXT_W, 3, LV_TEXT_ALIGN_CENTER);
    c.when = ui_label(c.root, &inter_20, UI_COLOR_SUBTLE, TEXT_W, 1, LV_TEXT_ALIGN_CENTER);
    c.head = ui_label(c.root, &inter_16, COLOR_EVENT, ROW_W, 1, LV_TEXT_ALIGN_LEFT);
    lv_label_set_text(c.head, "Tomorrow");
    lv_obj_set_hidden(c.head, true);
    for (int i = 0; i < ROWS; i++) {
        lv_obj_t *r = ui_plain(c.root, ROW_W, ROW_H);
        c.r[i].row = r;
        lv_obj_set_hidden(r, true);
        c.r[i].time = ui_label(r, &inter_16, UI_COLOR_SUBTLE, TIME_W, 1, LV_TEXT_ALIGN_LEFT);
        lv_obj_set_pos(c.r[i].time, 0, (ROW_H - lv_font_get_line_height(&inter_16)) / 2);
        c.r[i].title = ui_label(r, &inter_20, UI_COLOR_TEXT, ROW_W - TIME_W - 8, 1, LV_TEXT_ALIGN_LEFT);
        lv_obj_set_pos(c.r[i].title, TIME_W + 8, (ROW_H - lv_font_get_line_height(&inter_20)) / 2);
    }
    scr_calendar_set(&ui_empty_snap, 0);
    return c.root;
}
