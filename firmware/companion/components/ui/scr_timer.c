/* Timer and Stopwatch (design "Таймер · идёт", "Таймер · время вышло", "Секундомер · круги"), one screen with two modes. A swipe walks
 * through the presets 1 3 5 10 15 25 45 60 min and then the stopwatch. The coral ring melts with the time left, minute ticks run round
 * the edge, the top key (or a tap) starts / pauses / resumes; at zero "Time's up" pulses its digits, a tap adds a minute, the top key
 * dismisses. The stopwatch shows the last three laps and a dot that goes round once a minute; a tap on the pill laps (or resets when stopped).
 * The state and its lv_timer live here, not on the screen: the countdown carries on while another screen shows, and when it ends there
 * a "Time's up" toast appears. Nothing sounds.
 * Deviations: no bell icon (no icon font), digits and ring change once a second (the stopwatch has no tenths while it runs, they show
 * in the laps and once stopped), "Time's up" pulses the digits only (a pulsing ring would redraw the whole display twice a second),
 * the stopwatch's top key starts and stops (the design's lap is the pill), a paused timer goes back to Set with a swipe. */
#include <stdio.h>
#include <string.h>
#include "timer_core.h"
#include "ui_screens_priv.h"

#define N_PRESETS 8
#define DEFAULT_PRESET 2 /* 5 min */
#define TICK_MS 200      /* digits change once a second; this only keeps their phase close to the real one */
#define COLOR_TIMER 0xF06A58
#define COLOR_TIMER_TRACK 0x2A1716
#define COLOR_PAUSED 0x7A3B33
#define COLOR_PAUSED_TRACK 0x1E1414
#define COLOR_TIMER_TEXT 0xF6907F
#define COLOR_TICK 0x3A3546
#define COLOR_PILL 0x1E1C26
#define DOT_D 14
#define DOT_R 206 /* centre of the stopwatch dot from the display centre */
#define PILL_W 112
#define PILL_H 34
#define HIT_PAD 16
#define ROW_W 220
#define ROW_H 22

static const uint8_t preset_min[N_PRESETS] = { 1, 3, 5, 10, 15, 25, 45, 60 };

static struct {
    lv_obj_t *root, *ticks, *dot, *eb, *big, *sub, *hint, *pill, *pill_l, *row[SW_LAPS], *row_n[SW_LAPS], *row_t[SW_LAPS];
    ui_arc_t ring;
    lv_timer_t *timer;
    tmr_t t;
    sw_t sw;
    int pos; /* 0..N_PRESETS-1 a preset, N_PRESETS the stopwatch */
} s;

static bool sw_mode(void) { return s.pos == N_PRESETS; }

static void mmss(char out[12], uint32_t secs) { snprintf(out, 12, "%02u:%02u", (unsigned)(secs / 60 % 100), (unsigned)(secs % 60)); }

static void lap_fmt(char out[12], uint32_t ms) /* shortcut: 99:59.9 and beyond wraps, nobody times a lap that long */
{
    snprintf(out, 12, "%02u:%02u.%u", (unsigned)(ms / 60000 % 100), (unsigned)(ms / 1000 % 60), (unsigned)(ms / 100 % 10));
}

/* The lv_timer only runs while something counts (or "Time's up" is on show): an idle screen costs no wake-ups. */
static void sync_timer(void)
{
    bool visible = ui_current_screen() == SCR_TIMER;
    bool on = s.t.st == TMR_RUN || s.sw.running || (s.t.st == TMR_DONE && visible);
    if (on && lv_timer_get_paused(s.timer)) {
        lv_timer_reset(s.timer);
        lv_timer_resume(s.timer);
    } else if (!on && !lv_timer_get_paused(s.timer)) {
        lv_timer_pause(s.timer);
    }
}

static void tick_cb(lv_timer_t *t)
{
    (void)t;
    if (tmr_poll(&s.t, lv_tick_get()) && ui_current_screen() != SCR_TIMER) ui_toast("Time's up");
    if (ui_current_screen() == SCR_TIMER) scr_timer_set();
    sync_timer();
}

static void restack(void)
{
    lv_obj_t *col[] = { s.eb, s.big, s.sub, s.pill, s.row[0], s.row[1], s.row[2] };
    const uint8_t gap[] = { 0, 8, 4, 8, 6, 0, 0 };
    ui_stack(col, gap, 7, 0, UI_SCREEN_SIZE, -1);
}

static void put_dot(uint32_t secs)
{
    int16_t a = (int16_t)(secs % 60 * 6);
    lv_obj_set_pos(s.dot, UI_SCREEN_SIZE / 2 - DOT_D / 2 + DOT_R * lv_trigo_sin(a) / LV_TRIGO_SIN_MAX,
                   UI_SCREEN_SIZE / 2 - DOT_D / 2 - DOT_R * lv_trigo_sin(a + 90) / LV_TRIGO_SIN_MAX);
}

void scr_timer_set(void)
{
    uint32_t now = lv_tick_get();
    bool stopwatch = sw_mode();
    char big[12], sub[40] = "", eb[16] = "Timer";
    const char *hint;
    bool blink = false, ring = !stopwatch, idle = false;
    int pct = 100;
    uint32_t fg = COLOR_TIMER, track = COLOR_TIMER_TRACK;

    if (stopwatch) {
        uint32_t ms = sw_elapsed_ms(&s.sw, now);
        snprintf(eb, sizeof eb, "Stopwatch");
        mmss(big, ms / 1000);
        hint = s.sw.running ? "Stop" : "Start";
        idle = !s.sw.running && ms == 0;
        if (!s.sw.running && ms > 0) {
            char t[12];
            lap_fmt(t, ms);
            snprintf(sub, sizeof sub, "Stopped \xC2\xB7 %s", t);
        } else if (!s.sw.running) {
            snprintf(sub, sizeof sub, "Tap to start");
        }
        ui_set_text(s.pill_l, s.sw.running || idle ? "Lap" : "Reset");
        ui_text_color(s.pill_l, idle ? UI_COLOR_MUTED : COLOR_TIMER_TEXT); /* nothing to lap yet */
        put_dot(ms / 1000);
    } else {
        uint32_t left = tmr_left_ms(&s.t, now), secs = (left + 999) / 1000, total = (s.t.total_ms + 999) / 1000;
        mmss(big, secs);
        switch (s.t.st) {
        case TMR_SET:
            hint = "Start";
            snprintf(sub, sizeof sub, "Swipe to change");
            fg = COLOR_PAUSED; track = COLOR_PAUSED_TRACK;
            break;
        case TMR_RUN:
            hint = "Pause";
            mmss(eb, total); /* reuse: "of mm:ss" below */
            snprintf(sub, sizeof sub, "of %s", eb);
            snprintf(eb, sizeof eb, "Timer");
            pct = (int)((secs * 100 + total - 1) / total);
            break;
        case TMR_PAUSED:
            hint = "Resume";
            snprintf(eb, sizeof eb, "Paused");
            snprintf(sub, sizeof sub, "Swipe to reset");
            fg = COLOR_PAUSED; track = COLOR_PAUSED_TRACK;
            pct = (int)((secs * 100 + total - 1) / total);
            blink = (now / 1000) % 2;
            break;
        default: /* TMR_DONE */
            hint = "Stop";
            snprintf(eb, sizeof eb, "Time's up");
            snprintf(sub, sizeof sub, "Tap for +1 min");
            blink = (now / 500) % 2;
            break;
        }
    }

    ui_set_text(s.eb, eb);
    ui_text_color(s.eb, COLOR_TIMER_TEXT);
    ui_set_text(s.big, big);
    lv_opa_t opa = blink ? LV_OPA_30 : LV_OPA_COVER;
    if (lv_obj_get_style_text_opa(s.big, LV_PART_MAIN) != opa) lv_obj_set_style_text_opa(s.big, opa, 0);
    ui_set_text(s.sub, sub);
    lv_obj_set_hidden(s.sub, !stopwatch && !sub[0]); /* the stopwatch keeps its lines, so the pill stays where a finger found it */
    ui_set_text(s.hint, hint);
    lv_obj_set_hidden(s.pill, !stopwatch);
    lv_obj_set_hidden(s.dot, !stopwatch);
    lv_obj_set_hidden(s.ticks, !stopwatch && s.t.st == TMR_DONE);
    lv_obj_set_hidden(s.ring.obj, !ring);
    if (ring) ui_arc_set(&s.ring, pct, fg, track);
    for (int i = 0; i < SW_LAPS; i++) {
        bool on = (uint32_t)i < s.sw.n_laps;
        lv_obj_set_hidden(s.row[i], !stopwatch);
        char n[12] = "", t[12] = "";
        if (on) {
            snprintf(n, sizeof n, "Lap %u", (unsigned)(s.sw.n_laps - (uint32_t)i));
            lap_fmt(t, s.sw.lap_ms[i]);
        }
        ui_set_text(s.row_n[i], n);
        ui_set_text(s.row_t[i], t);
    }
    restack();
}

void scr_timer_summary(char *out, size_t cap)
{
    out[0] = 0;
    if (s.t.st == TMR_RUN) {
        char t[12];
        mmss(t, (tmr_left_ms(&s.t, lv_tick_get()) + 999) / 1000);
        snprintf(out, cap, "%s left", t);
    } else if (s.t.st == TMR_PAUSED) snprintf(out, cap, "Paused");
    else if (s.t.st == TMR_DONE) snprintf(out, cap, "Time's up");
}

static void changed(void)
{
    scr_timer_set();
    sync_timer();
}

void scr_timer_swipe(int dir)
{
    if (!sw_mode() && s.t.st == TMR_PAUSED) {
        tmr_reset(&s.t);
    } else if ((sw_mode() && !s.sw.running) || (!sw_mode() && s.t.st == TMR_SET)) {
        s.pos = (s.pos + (dir < 0 ? N_PRESETS : 1)) % (N_PRESETS + 1);
        if (!sw_mode()) tmr_set_preset(&s.t, preset_min[s.pos] * 60000u);
    }
    changed();
}

void scr_timer_top(void)
{
    uint32_t now = lv_tick_get();
    if (sw_mode()) sw_toggle(&s.sw, now);
    else if (s.t.st == TMR_DONE) tmr_reset(&s.t);
    else tmr_toggle(&s.t, now);
    changed();
}

static bool pill_hit(int32_t x, int32_t y)
{
    lv_area_t a;
    lv_obj_update_layout(s.root);
    if (lv_obj_is_hidden(s.pill)) return false;
    lv_obj_get_coords(s.pill, &a);
    return x >= a.x1 - HIT_PAD && x <= a.x2 + HIT_PAD && y >= a.y1 - HIT_PAD && y <= a.y2 + HIT_PAD;
}

void scr_timer_tap(int32_t x, int32_t y)
{
    uint32_t now = lv_tick_get();
    if (sw_mode() && pill_hit(x, y)) {
        if (!sw_lap(&s.sw, now)) sw_reset(&s.sw);
        changed();
    } else if (!sw_mode() && s.t.st == TMR_DONE) {
        tmr_add_minute(&s.t, now);
        changed();
    } else {
        scr_timer_top();
    }
}

static void ticks_draw(lv_event_t *e)
{
    lv_area_t a;
    lv_obj_get_coords(lv_event_get_target_obj(e), &a);
    lv_draw_line_dsc_t l;
    lv_draw_line_dsc_init(&l);
    l.color = lv_color_hex(COLOR_TICK);
    l.width = 2;
    for (int i = 0; i < 60; i++) { /* every minute mark, 10 px long, from 195 px out of the centre */
        int16_t d = (int16_t)(i * 6);
        int32_t sn = lv_trigo_sin(d), cs = lv_trigo_sin(d + 90);
        l.p1.x = a.x1 + UI_SCREEN_SIZE / 2 + 195 * sn / LV_TRIGO_SIN_MAX;
        l.p1.y = a.y1 + UI_SCREEN_SIZE / 2 - 195 * cs / LV_TRIGO_SIN_MAX;
        l.p2.x = a.x1 + UI_SCREEN_SIZE / 2 + 205 * sn / LV_TRIGO_SIN_MAX;
        l.p2.y = a.y1 + UI_SCREEN_SIZE / 2 - 205 * cs / LV_TRIGO_SIN_MAX;
        lv_draw_line(lv_event_get_layer(e), &l);
    }
}

lv_obj_t *scr_timer_create(lv_obj_t *parent)
{
    s.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    ui_arc_create(&s.ring, s.root);
    s.ticks = ui_plain(s.root, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    lv_obj_set_user_flag(s.ticks, 1, true); /* custom paint, see invalidate_painted() in screens.c */
    lv_obj_add_event_cb(s.ticks, ticks_draw, LV_EVENT_DRAW_MAIN, NULL);
    s.dot = ui_plain(s.root, DOT_D, DOT_D);
    lv_obj_set_style_radius(s.dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(s.dot, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s.dot, lv_color_hex(COLOR_TIMER_TEXT), 0);
    s.eb = ui_label(s.root, &inter_16, COLOR_TIMER_TEXT, 300, 1, LV_TEXT_ALIGN_CENTER);
    s.big = ui_label(s.root, &inter_clock_96, UI_COLOR_TEXT, 330, 1, LV_TEXT_ALIGN_CENTER);
    s.sub = ui_label(s.root, &inter_20, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    s.pill = ui_plain(s.root, PILL_W, PILL_H);
    lv_obj_set_style_radius(s.pill, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(s.pill, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s.pill, lv_color_hex(COLOR_PILL), 0);
    s.pill_l = ui_label(s.pill, &inter_20, COLOR_TIMER_TEXT, PILL_W, 1, LV_TEXT_ALIGN_CENTER);
    lv_obj_center(s.pill_l);
    for (int i = 0; i < SW_LAPS; i++) {
        s.row[i] = ui_plain(s.root, ROW_W, ROW_H);
        s.row_n[i] = ui_label(s.row[i], &inter_16, UI_COLOR_SUBTLE, ROW_W / 2, 1, LV_TEXT_ALIGN_LEFT);
        s.row_t[i] = ui_label(s.row[i], &inter_16, UI_COLOR_TEXT, ROW_W / 2, 1, LV_TEXT_ALIGN_RIGHT);
        lv_obj_set_pos(s.row_n[i], 0, 0);
        lv_obj_set_pos(s.row_t[i], ROW_W / 2, 0);
    }
    /* at the top key, right edge, like the Focus hint */
    s.hint = ui_label(s.root, &inter_16, COLOR_TIMER_TEXT, 90, 1, LV_TEXT_ALIGN_RIGHT);
    lv_obj_set_pos(s.hint, 394 - 90, 98);
    s.pos = DEFAULT_PRESET;
    tmr_init(&s.t, preset_min[s.pos] * 60000u);
    memset(&s.sw, 0, sizeof s.sw);
    if (!s.timer) { /* a repeated setup (host tests) keeps the one timer */
        s.timer = lv_timer_create(tick_cb, TICK_MS, NULL);
        lv_timer_pause(s.timer);
    }
    scr_timer_set();
    return s.root;
}
