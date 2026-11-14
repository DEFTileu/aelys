/* Calendar (design "Календарь · следующее"): the next event large, a coral ring that fills over the last 60 minutes before it starts
 * (full once it has started), the relative line on top ("in 25 min", "now", "started 10 min ago"), the title (up to 3 lines) and
 * "16:00 - 17:00" or "All day". The board only gets one event, so there is no list of the rest of the day and no tomorrow row.
 * render() runs once a second for the visible screen and only changed labels or ring steps redraw: the text moves once a minute,
 * once a second in the last minute before the start.
 * Deviations: the relative line is not upper-cased and not letter-spaced; no location after the time (the snapshot has none);
 * a plain hyphen between the times (the fonts have no en dash). */
#include <stdio.h>
#include <string.h>
#include "ui_screens_priv.h"

#define TEXT_W 280
#define RING_WINDOW_S 3600
#define COLOR_EVENT 0xFF8A84
#define COLOR_EVENT_TRACK 0x2A1618

static struct { lv_obj_t *root, *eb, *title, *when; ui_arc_t ring; } c;

static void restack(void)
{
    lv_obj_t *col[] = { c.eb, c.title, c.when };
    const uint8_t gap[] = { 0, 6, 8 };
    ui_stack(col, gap, 3, 0, UI_SCREEN_SIZE, -1);
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
    if (s->has_event) {
        const snap_event_t *e = &s->event;
        snprintf(title, sizeof title, "%s", e->title);
        if (e->all_day) {
            snprintf(when, sizeof when, "All day");
            if (now > 0) snprintf(eb, sizeof eb, "Today");
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
    lv_obj_set_height(c.title, ui_text_height(title, &inter_28, TEXT_W, 3));
    ui_set_text(c.when, when);
    lv_obj_set_hidden(c.when, !when[0]);
    lv_obj_set_hidden(c.ring.obj, !ring);
    ui_arc_set(&c.ring, pct, COLOR_EVENT, COLOR_EVENT_TRACK);
    restack();
}

lv_obj_t *scr_calendar_create(lv_obj_t *parent)
{
    c.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    ui_arc_create(&c.ring, c.root);
    lv_obj_set_hidden(c.ring.obj, true);
    c.eb = ui_label(c.root, &inter_16, COLOR_EVENT, 260, 1, LV_TEXT_ALIGN_CENTER);
    c.title = ui_label(c.root, &inter_28, UI_COLOR_TEXT, TEXT_W, 3, LV_TEXT_ALIGN_CENTER);
    c.when = ui_label(c.root, &inter_20, UI_COLOR_SUBTLE, TEXT_W, 1, LV_TEXT_ALIGN_CENTER);
    scr_calendar_set(&(snap_t){ 0 }, 0);
    return c.root;
}
