/* Screen switching: home, Today, Focus, Inbox, lost mode, the ICE card and the pairing screen are full-size objects on the
 * one active LVGL screen, shown and hidden by screen_next(); one more overlay shows the both-buttons progress and a toast
 * sits on top. The snapshot (ui_snap_tb) is rendered into every screen by render(), on each event that can change it and
 * once a second (relative times, the focus countdown, the "due within 60 min" mood). */
#define _POSIX_C_SOURCE 200809L /* localtime_r, setenv, tzset under -std=c11 */
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "ui_screens_priv.h"

#define ICE_TIMEOUT_MS 15000
#define PAIRED_SHOW_MS 2000
#define INBOX_TIMEOUT_MS 15000
#define HOLD_STOP_MS 800
#define HAPPY_MS 3000

tribuf_t ui_owner_tb;
static owner_info_t owner_buf[3];
tribuf_t ui_snap_tb;
static snap_t *snap_buf; /* 3 slots, from the LVGL allocator (PSRAM on the board): 3.3 KB that internal RAM can spare */

static const snap_t empty_snap; /* before the first publish, or when the buffer could not be allocated */

static struct {
    scr_t cur, down_scr; /* down_scr: the screen showing when the current touch began */
    bool lost, happy, have_time, find; /* find: the "Here I am!" overlay is up */
    uint8_t link, hh, mm; /* link: ui_link_state_t */
    lv_obj_t *scr[SCR_COUNT]; /* indexed by scr_t; NULL for screens that do not exist yet */
    lv_timer_t *ice_timer, *paired_timer, *inbox_timer, *hold_timer, *happy_timer, *tick_timer;
    const snap_t *snap;  /* the newest published snapshot; unchanged until the next tribuf_latest() */
    uint32_t snap_ms;    /* lv_tick_get() when it arrived */
    char done_id[40];    /* optimistic marks: task.complete / notification.read sent for these ids */
    char read_id[5][40];
    char pend_read[5][40]; /* ids of notification.read still unanswered, oldest first: UI_EV_ACTION carries no target */
    bool (*sink)(act_kind_t, const char *);
    void (*find_stop)(void);
    int64_t (*clock)(void);
} g;

lv_obj_t *ui_plain(lv_obj_t *parent, int32_t w, int32_t h)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_set_clickable(o, false);
    lv_obj_set_scrollable(o, false);
    lv_obj_set_style_bg_opa(o, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(o, 0, 0);
    lv_obj_set_style_pad_all(o, 0, 0);
    lv_obj_set_style_radius(o, 0, 0);
    lv_obj_set_size(o, w, h);
    lv_obj_update_layout(o); /* lv_obj_get_width/height read the real size only after this */
    return o;
}

lv_obj_t *ui_ring(lv_obj_t *parent, int32_t inset, int32_t width, uint32_t color)
{
    lv_obj_t *o = ui_plain(parent, UI_SCREEN_SIZE - 2 * inset, UI_SCREEN_SIZE - 2 * inset);
    lv_obj_set_pos(o, inset, inset);
    lv_obj_set_style_radius(o, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(o, width, 0);
    lv_obj_set_style_border_color(o, lv_color_hex(color), 0);
    return o;
}

lv_obj_t *ui_label(lv_obj_t *parent, const lv_font_t *font, uint32_t color, int32_t w, int32_t lines,
                   lv_text_align_t align)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_label_set_long_mode(l, LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_obj_set_style_text_align(l, align, 0);
    lv_obj_set_size(l, w, lines * lv_font_get_line_height(font));
    lv_obj_update_layout(l);
    return l;
}

int32_t ui_text_height(const char *txt, const lv_font_t *font, int32_t w, int32_t max_lines)
{
    lv_point_t sz;
    int32_t lh = lv_font_get_line_height(font);
    lv_text_get_size(&sz, txt, font, 0, 0, w, LV_TEXT_FLAG_NONE);
    if (sz.y < lh) sz.y = lh;
    return sz.y > max_lines * lh ? max_lines * lh : sz.y;
}

void ui_stack(lv_obj_t *const o[], const uint8_t gap[], int n, int32_t area_y, int32_t area_h, int32_t x)
{
    int32_t total = 0;
    bool first = true;
    lv_obj_update_layout(lv_obj_get_parent(o[0]));
    for (int i = 0; i < n; i++) {
        if (lv_obj_is_hidden(o[i])) continue;
        total += lv_obj_get_height(o[i]) + (first ? 0 : gap[i]);
        first = false;
    }
    int32_t y = area_y + (area_h - total) / 2;
    first = true;
    for (int i = 0; i < n; i++) {
        if (lv_obj_is_hidden(o[i])) continue;
        if (!first) y += gap[i];
        first = false;
        lv_obj_set_pos(o[i], x < 0 ? (lv_obj_get_width(lv_obj_get_parent(o[i])) - lv_obj_get_width(o[i])) / 2 : x, y); /* set_pos ignores an unchanged value */
        y += lv_obj_get_height(o[i]);
    }
}

scr_t ui_current_screen(void) { return g.cur; }

void ui_set_text(lv_obj_t *label, const char *txt)
{
    if (strcmp(lv_label_get_text(label), txt)) lv_label_set_text(label, txt);
}

void ui_text_color(lv_obj_t *o, uint32_t c)
{
    lv_color_t n = lv_color_hex(c);
    if (!lv_color_eq(lv_obj_get_style_text_color(o, LV_PART_MAIN), n)) lv_obj_set_style_text_color(o, n, 0);
}

void ui_set_action_sink(bool (*sink)(act_kind_t, const char *)) { g.sink = sink; }
void ui_set_clock(int64_t (*now)(void)) { g.clock = now; }
void ui_set_find_stop(void (*stop)(void)) { g.find_stop = stop; }

int64_t ui_now(void)
{
    if (g.clock) return g.clock();
    time_t t = time(NULL);
    return t < 1704067200 ? 0 : (int64_t)t; /* before 2024: the clock was never set */
}

void ui_fmt_hm(char out[8], int64_t epoch)
{
    time_t t = (time_t)epoch;
    struct tm tm;
    if (epoch <= 0 || !localtime_r(&t, &tm)) { strcpy(out, "--:--"); return; }
    snprintf(out, 8, "%02d:%02d", tm.tm_hour % 100, tm.tm_min % 100);
}

bool ui_marked_done(const char *id) { return id[0] && !strcmp(g.done_id, id); }

bool ui_marked_read(const char *id)
{
    for (int i = 0; i < 5; i++)
        if (id[0] && !strcmp(g.read_id[i], id)) return true;
    return false;
}

static void arc_draw(lv_event_t *e)
{
    const ui_arc_t *a = lv_event_get_user_data(e);
    lv_area_t box;
    lv_obj_get_coords(lv_event_get_target_obj(e), &box);
    lv_draw_arc_dsc_t d;
    lv_draw_arc_dsc_init(&d);
    d.width = 12;
    d.center.x = box.x1 + UI_SCREEN_SIZE / 2;
    d.center.y = box.y1 + UI_SCREEN_SIZE / 2;
    d.radius = UI_SCREEN_SIZE / 2 - 8;
    d.start_angle = 0;
    d.end_angle = 360;
    d.color = lv_color_hex(a->track);
    lv_draw_arc(lv_event_get_layer(e), &d);
    if (a->pct <= 0) return;
    d.color = lv_color_hex(a->fg);
    if (a->pct >= 100) { /* a closed ring: one full circle, no notch at 12 o'clock */
        d.start_angle = 0;
        d.end_angle = 360;
    } else {
        d.start_angle = 270; /* 12 o'clock; LVGL angles run clockwise from 3 o'clock */
        d.end_angle = 270 + 360 * a->pct / 100;
    }
    lv_draw_arc(lv_event_get_layer(e), &d);
}

void ui_arc_create(ui_arc_t *a, lv_obj_t *parent)
{
    a->obj = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    a->pct = 0;
    a->fg = UI_COLOR_ACCENT;
    a->track = UI_COLOR_ORBIT_OFF;
    lv_obj_add_event_cb(a->obj, arc_draw, LV_EVENT_DRAW_MAIN, a);
}

void ui_arc_set(ui_arc_t *a, int pct, uint32_t fg, uint32_t track)
{
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    if (pct == a->pct && fg == a->fg && track == a->track) return;
    a->pct = pct; a->fg = fg; a->track = track;
    lv_obj_invalidate(a->obj);
}

static void tick_draw(lv_event_t *e)
{
    lv_area_t a;
    lv_obj_get_coords(lv_event_get_target_obj(e), &a);
    int32_t d = lv_area_get_width(&a);
    lv_draw_line_dsc_t l;
    lv_draw_line_dsc_init(&l);
    l.color = lv_color_hex(0xFFFFFF);
    l.width = d / 8 < 2 ? 2 : d / 8;
    l.round_start = l.round_end = true;
    const int32_t px[3] = { d * 27 / 100, d * 44 / 100, d * 74 / 100 }, py[3] = { d * 53 / 100, d * 69 / 100, d * 34 / 100 };
    for (int i = 0; i < 2; i++) {
        l.p1.x = a.x1 + px[i]; l.p1.y = a.y1 + py[i];
        l.p2.x = a.x1 + px[i + 1]; l.p2.y = a.y1 + py[i + 1];
        lv_draw_line(lv_event_get_layer(e), &l);
    }
}

lv_obj_t *ui_check_create(lv_obj_t *parent, int32_t d)
{
    lv_obj_t *c = ui_plain(parent, d, d);
    lv_obj_set_style_radius(c, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(c, 2, 0);
    lv_obj_t *t = ui_plain(c, d - 4, d - 4); /* inside the border */
    lv_obj_add_event_cb(t, tick_draw, LV_EVENT_DRAW_MAIN, NULL);
    ui_check_set(c, false, 0);
    return c;
}

void ui_check_set(lv_obj_t *c, bool on, uint32_t fill)
{
    lv_obj_t *tick = lv_obj_get_child(c, 0);
    if (!lv_obj_is_hidden(tick) == on && lv_color_eq(lv_obj_get_style_bg_color(c, LV_PART_MAIN), lv_color_hex(fill))) return; /* unchanged: no redraw */
    lv_obj_set_style_bg_opa(c, on ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
    lv_obj_set_style_bg_color(c, lv_color_hex(fill), 0);
    lv_obj_set_style_border_color(c, lv_color_hex(on ? fill : 0x6B6676), 0);
    lv_obj_set_hidden(tick, !on);
}

static void show(scr_t s);

static void ice_timeout(lv_timer_t *t)
{
    (void)t;
    g.ice_timer = NULL; /* one-shot: LVGL deletes it after this call */
    show(screen_next(g.cur, g.lost, UI_EV_TOUCH)); /* as a tap on the card: back to home or lost mode (not a real touch: it must not stop a find) */
}

/* A toast belongs to the everyday screens: never over lost mode, the ICE card or the pairing screen. */
static bool toast_ok(void) { return g.cur != SCR_LOST && g.cur != SCR_ICE && g.cur != SCR_PAIR && !g.lost && !g.find; }
static void toast(const char *txt)
{
    if (toast_ok()) scr_toast_show(txt);
}

/* Bytes of an event payload from off up to the first NUL, cut to cap - 1; a short event gives "". */
static void ev_str(char *dst, size_t cap, const ui_event_t *ev, size_t off)
{
    size_t n = 0;
    while (off + n < ev->len && n + 1 < cap && ev->data[off + n]) { dst[n] = (char)ev->data[off + n]; n++; }
    dst[n] = '\0';
}

static void paired_timeout(lv_timer_t *t)
{
    (void)t;
    g.paired_timer = NULL; /* one-shot */
    scr_t next = screen_next_pair(g.cur, g.lost, PAIR_UI_DONE);
    if (next != g.cur) show(next);
}

static void render(void);

/* One-shot timers: LVGL deletes them after the callback, so the callback clears the pointer. */
static void stop_timer(lv_timer_t **t)
{
    if (*t) { lv_timer_delete(*t); *t = NULL; }
}

static void arm_timer(lv_timer_t **t, lv_timer_cb_t cb, uint32_t ms)
{
    if (*t) {
        lv_timer_reset(*t);
    } else {
        *t = lv_timer_create(cb, ms, NULL);
        lv_timer_set_repeat_count(*t, 1);
    }
}

static void inbox_timeout(lv_timer_t *t)
{
    (void)t;
    g.inbox_timer = NULL;
    scr_t next = screen_next_btn(g.cur, g.lost, BTN_LOW); /* 15 s without a touch: back to Today, like the low key */
    if (g.cur == SCR_INBOX && next != g.cur) show(next);
}

static void show(scr_t s)
{
    for (int i = 0; i < SCR_COUNT; i++)
        if (g.scr[i]) lv_obj_set_hidden(g.scr[i], i != (int)s);
    g.cur = s;
    scr_hold_set(0);
    stop_timer(&g.hold_timer);
    if (s == SCR_LOST || s == SCR_ICE || s == SCR_PAIR) scr_toast_hide();
    if (s != SCR_LOST) scr_lost_hide_hint();
    if (s == SCR_ICE) arm_timer(&g.ice_timer, ice_timeout, ICE_TIMEOUT_MS);
    else stop_timer(&g.ice_timer);
    if (s == SCR_INBOX) arm_timer(&g.inbox_timer, inbox_timeout, INBOX_TIMEOUT_MS);
    else stop_timer(&g.inbox_timer);
    if (s != SCR_PAIR) stop_timer(&g.paired_timer);
}

static void set_owner(const owner_info_t *o)
{
    scr_lost_set_owner(o);
    scr_ice_set_owner(o);
}

/* Draw the newest snapshot into every screen. Idempotent and cheap: widgets only change when their text or colour does. */
static void render(void)
{
    const snap_t *s = g.snap ? g.snap : &empty_snap;
    int64_t now = ui_now();
    bool offline = g.link == LINK_UI_OFFLINE;
    scr_home_set_snap(s, now, ui_mood_for(s, now, !offline, g.happy), offline);
    scr_today_set(s, now);
    scr_focus_set(s, g.snap_ms, lv_tick_get());
    scr_inbox_set(s, now);
}

static void tick_timer_cb(lv_timer_t *t)
{
    (void)t;
    render();
}

static void happy_timeout(lv_timer_t *t)
{
    (void)t;
    g.happy_timer = NULL;
    g.happy = false;
    render();
}

/* Send an action: a refused one (no pairing, offline, queue full) shows "No connection" at once. */
static bool act(act_kind_t k, const char *target)
{
    if (g.sink && g.sink(k, target)) return true;
    toast("No connection");
    return false;
}

static void hold_timeout(lv_timer_t *t)
{
    (void)t;
    g.hold_timer = NULL;
    if (g.cur == SCR_FOCUS && !g.lost && scr_focus_view() == FV_PAUSED) act(ACT_FOCUS_STOP, NULL);
}

static void mark_read(const char *id)
{
    for (int i = 0; i < 5; i++)
        if (!g.read_id[i][0]) { snprintf(g.read_id[i], sizeof g.read_id[i], "%s", id); break; }
    for (int i = 0; i < 5; i++)
        if (!g.pend_read[i][0]) { snprintf(g.pend_read[i], sizeof g.pend_read[i], "%s", id); return; }
}

/* An answer to the oldest open notification.read; on failure only that notice loses its tick.
 * shortcut: assumes answers come in the order the reads were sent; upgrade by carrying the target id in UI_EV_ACTION. */
static void read_answered(bool ok)
{
    char id[40];
    snprintf(id, sizeof id, "%s", g.pend_read[0]);
    memmove(g.pend_read[0], g.pend_read[1], sizeof g.pend_read - sizeof g.pend_read[0]);
    memset(g.pend_read[4], 0, sizeof g.pend_read[4]);
    if (ok) return;
    for (int i = 0; i < 5; i++)
        if (id[0] && !strcmp(g.read_id[i], id)) g.read_id[i][0] = 0;
}

/* A fresh snapshot: marks for things the server no longer lists are dropped. */
static void prune_marks(const snap_t *s)
{
    if (!s->has_task || strcmp(s->task.id, g.done_id)) g.done_id[0] = 0;
    for (int i = 0; i < 5; i++) {
        bool listed = false;
        for (int n = 0; n < s->n_notices && n < 5; n++) listed = listed || !strcmp(s->notices[n].id, g.read_id[i]);
        if (!listed) g.read_id[i][0] = 0;
    }
}

void ui_setup(void)
{
    lv_obj_t *root = lv_screen_active();
    ui_theme_apply(root);
    g.scr[SCR_HOME] = scr_home_create(root);
    g.scr[SCR_TODAY] = scr_today_create(root);
    g.scr[SCR_FOCUS] = scr_focus_create(root);
    g.scr[SCR_INBOX] = scr_inbox_create(root);
    g.scr[SCR_LOST] = scr_lost_create(root);
    g.scr[SCR_ICE] = scr_ice_create(root);
    g.scr[SCR_PAIR] = scr_pair_create(root);
    scr_hold_create(root);
    scr_toast_create(root);
    scr_find_create(root); /* last: on top of the toast and every screen */
    for (int i = 0; i < 3; i++) owner_defaults(&owner_buf[i]);
    tribuf_init(&ui_owner_tb, &owner_buf[0], &owner_buf[1], &owner_buf[2]);
    snap_buf = lv_malloc_zeroed(3 * sizeof *snap_buf); /* zeroed: no snapshot yet */
    if (snap_buf) tribuf_init(&ui_snap_tb, &snap_buf[0], &snap_buf[1], &snap_buf[2]); /* else slot[0] stays NULL: producers skip it */
    set_owner(tribuf_latest(&ui_owner_tb, NULL));
    g.lost = g.happy = g.have_time = g.find = false;
    scr_find_show(false);
    g.link = LINK_UI_UNPAIRED;
    g.snap = snap_buf ? tribuf_latest(&ui_snap_tb, NULL) : NULL;
    g.done_id[0] = 0;
    memset(g.read_id, 0, sizeof g.read_id);
    memset(g.pend_read, 0, sizeof g.pend_read);
    if (!g.tick_timer) g.tick_timer = lv_timer_create(tick_timer_cb, 1000, NULL);
    render();
    show(SCR_HOME);
}

static void on_tap(int32_t x, int32_t y, scr_t *next)
{
    const snap_t *s = g.snap ? g.snap : &empty_snap;
    tap_hit_t hit = TAP_OUTSIDE;
    int row = -1;
    if (g.cur == SCR_TODAY) {
        hit = scr_today_hit(x, y);
        if (hit == TAP_ROW && s->has_task && !ui_marked_done(s->task.id) && act(ACT_TASK_COMPLETE, s->task.id))
            snprintf(g.done_id, sizeof g.done_id, "%s", s->task.id);
    } else if (g.cur == SCR_INBOX) {
        row = scr_inbox_hit(x, y);
        hit = row >= 0 ? TAP_ROW : TAP_OUTSIDE;
        if (row >= 0 && row < s->n_notices) {
            const char *id = s->notices[row].id;
            if (!ui_marked_read(id) && act(ACT_NOTIFICATION_READ, id)) mark_read(id);
        }
        arm_timer(&g.inbox_timer, inbox_timeout, INBOX_TIMEOUT_MS); /* a touch in the inbox restarts the 15 s */
    } else if (g.cur == SCR_FOCUS && scr_focus_view() == FV_NONE) {
        act(ACT_FOCUS_START, NULL);
    }
    *next = screen_next_tap(g.cur, g.lost, hit);
}

static void on_action_result(const ui_event_t *ev)
{
    if (ev->len < 2) return;
    if (ev->data[0] == ACT_NOTIFICATION_READ) read_answered(ev->data[1] != 0);
    if (ev->data[1]) {
        if (ev->data[0] == ACT_TASK_COMPLETE) { /* Aelys cheers for 3 s */
            g.happy = true;
            arm_timer(&g.happy_timer, happy_timeout, HAPPY_MS);
        }
        return;
    }
    if (ev->data[0] == ACT_TASK_COMPLETE) g.done_id[0] = 0; /* the tick was optimistic: take it back */
    const char *err = ev->len >= 3 ? (const char *)&ev->data[2] : "";
    toast(!strncmp(err, "OFFLINE", 8) ? "No connection" : "Didn't work \xE2\x80\x94 try again");
}

/* Input that ends a find: a touch, a key click, both buttons held (not the 0 % of letting go). */
static bool ends_find(const ui_event_t *ev)
{
    return ev->type == UI_EV_TOUCH || ev->type == UI_EV_BTN || ev->type == UI_EV_COMBO_FIRE ||
           (ev->type == UI_EV_COMBO_PROGRESS && ev->len >= 1 && ev->data[0] > 0);
}

void ui_handle_event(const ui_event_t *ev)
{
    scr_t next = g.cur;
    if (g.find && ends_find(ev)) {
        g.find = false;
        scr_find_show(false);
        if (g.find_stop) g.find_stop();
        if (ev->type == UI_EV_TOUCH) g.down_scr = SCR_COUNT; /* the tap, swipe and release of this touch are not for the screen below */
        if (ev->type == UI_EV_TOUCH || ev->type == UI_EV_BTN) return;
    }
    switch (ev->type) {
    case UI_EV_TIME:
        if (ev->len >= 2) {
            g.have_time = true; g.hh = ev->data[0]; g.mm = ev->data[1];
            scr_home_set_time(ev->data[0], ev->data[1]);
            scr_today_set_time(ev->data[0], ev->data[1]);
            render(); /* the date and the relative times may have moved on */
        }
        return;
    case UI_EV_WIFI:
        if (ev->len >= 1) scr_home_set_wifi(ev->data[0]);
        return;
    case UI_EV_WIFI_ADD: {
        if (ev->len >= 1 && ev->data[0] == 3) { scr_wifi_card_hide(); return; } /* the attempt never ran */
        if (ev->len < 2 || !toast_ok()) return; /* lost mode, ICE card, pairing: nothing (the command still runs on the board) */
        char ssid[33], prev[26];
        ev_str(ssid, sizeof ssid, ev, 1);
        ev_str(prev, sizeof prev, ev, 34);
        scr_wifi_card_show(ev->data[0], ssid, prev);
        return;
    }
    case UI_EV_OWNER: {
        bool fresh;
        const owner_info_t *o = tribuf_latest(&ui_owner_tb, &fresh);
        if (fresh) set_owner(o);
        return;
    }
    case UI_EV_SNAPSHOT: {
        if (!snap_buf) return;
        bool fresh;
        const snap_t *p = tribuf_latest(&ui_snap_tb, &fresh);
        if (fresh) {
            g.snap = p;
            g.snap_ms = lv_tick_get();
            prune_marks(p);
        }
        render();
        return;
    }
    case UI_EV_LINK:
        if (ev->len < 1) return;
        g.link = ev->data[0];
        scr_home_set_paired(ev->data[0] != LINK_UI_UNPAIRED);
        scr_home_set_welcome(ev->data[0] == LINK_UI_UNPAIRED);
        render();
        return;
    case UI_EV_PAIR: {
        if (ev->len < 1) return;
        ui_pair_t what = (ui_pair_t)ev->data[0];
        if (what == PAIR_UI_CODE) {
            if (ev->len < 7 || screen_next_pair(g.cur, g.lost, what) != SCR_PAIR || !scr_pair_set_code((const char *)&ev->data[1]))
                return;
            stop_timer(&g.paired_timer); /* a new code replaces the card */
            next = SCR_PAIR;
        } else if (what == PAIR_UI_DONE) {
            scr_home_set_paired(true); /* paired: the first-boot welcome is over, whatever screen is up */
            scr_home_set_welcome(false);
            if (screen_next_pair(g.cur, g.lost, PAIR_UI_CODE) != SCR_PAIR) return; /* lost mode / ICE card: no card */
            scr_pair_set_done();
            arm_timer(&g.paired_timer, paired_timeout, PAIRED_SHOW_MS);
            next = SCR_PAIR;
        } else if (what == PAIR_UI_HIDE) {
            next = screen_next_pair(g.cur, g.lost, what);
        } else {
            return;
        }
        break;
    }
    case UI_EV_FIND:
        if (ev->len < 1) return;
        g.find = ev->data[0] != 0;
        scr_find_show(g.find);
        return;
    case UI_EV_COMBO_PROGRESS:
        /* the overlay is for opening the card: not while it is already open */
        scr_hold_set(g.cur == SCR_ICE || ev->len < 1 ? 0 : ev->data[0]);
        return;
    case UI_EV_LOST:
        if (ev->len < 1) return;
        g.lost = ev->data[0] != 0;
        if (g.cur == SCR_ICE) return; /* the card stays open; dismissing it picks the right screen */
        next = screen_next(g.cur, g.lost, UI_EV_LOST);
        break;
    case UI_EV_TOUCH:
        g.down_scr = g.cur;
        /* Focus paused: a finger held 800 ms stops the session (UI_EV_RELEASE or any gesture cancels it) */
        if (!g.lost && g.cur == SCR_FOCUS && scr_focus_view() == FV_PAUSED)
            arm_timer(&g.hold_timer, hold_timeout, HOLD_STOP_MS);
        next = screen_next(g.cur, g.lost, UI_EV_TOUCH);
        break;
    case UI_EV_RELEASE:
        stop_timer(&g.hold_timer);
        return;
    case UI_EV_TAP:
        stop_timer(&g.hold_timer);
        /* a touch that began on another screen (it closed the ICE card) is not a tap on this one */
        if (g.lost && g.cur == SCR_LOST && g.down_scr == SCR_LOST) scr_lost_show_hint();
        if (g.lost || ev->len < 4 || g.down_scr != g.cur) return;
        on_tap((int32_t)(ev->data[0] | ev->data[1] << 8), (int32_t)(ev->data[2] | ev->data[3] << 8), &next);
        break;
    case UI_EV_SWIPE_LEFT:
    case UI_EV_SWIPE_RIGHT:
        stop_timer(&g.hold_timer);
        if (g.down_scr != g.cur) return;
        if (g.cur == SCR_LOST) scr_lost_show_hint();
        next = screen_next(g.cur, g.lost, (ui_event_type_t)ev->type);
        break;
    case UI_EV_BTN:
        if (g.cur == SCR_LOST && ev->len >= 1) scr_lost_show_hint();
        if (g.lost || ev->len < 1) return;
        if (ev->data[0] == BTN_TOP && g.cur == SCR_FOCUS) {
            act(scr_focus_top_action(), NULL);
        }
        next = screen_next_btn(g.cur, g.lost, (ui_btn_t)ev->data[0]);
        break;
    case UI_EV_ACTION:
        if (!g.lost) {
            on_action_result(ev);
            render();
        }
        return;
    default:
        next = screen_next(g.cur, g.lost, (ui_event_type_t)ev->type);
        break;
    }
    if (next != g.cur || ev->type == UI_EV_COMBO_FIRE) show(next);
}
