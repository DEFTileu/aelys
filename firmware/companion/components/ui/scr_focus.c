/* Focus (design "Focus · идёт", "Focus · пауза", "Focus · сессия завершена"): coral ring that melts away over the 25 min
 * pomodoro, a small Aelys, the time left, and the top-key hint at the key on the right edge. A stopwatch counts up and has
 * no ring. Deviations: no sparkles on "Session done", no "n of 4" counter or task name (the snapshot has neither), no
 * break view; the hint of "Session done" says "Done" (focus.stop), as the brief asks, not the design's "Break". */
#include <stdio.h>
#include <string.h>
#include "ui_screens_priv.h"

#define POMODORO_S (25 * 60)
#define COLOR_FOCUS 0xF06A58
#define COLOR_FOCUS_TRACK 0x2A1716
#define COLOR_PAUSED 0x7A3B33
#define COLOR_PAUSED_TRACK 0x1E1414
#define COLOR_FOCUS_TEXT 0xF6907F
#define COLOR_BREAK 0x5FD7A8

static struct {
    lv_obj_t *root, *face, *eb, *big, *title, *sub, *hold, *hint;
    ui_arc_t ring;
    focus_view_t view;
    mood_t mood;
} h;

static void restack(void)
{
    lv_obj_t *col[] = { h.face, h.eb, h.title, h.big, h.sub, h.hold };
    const uint8_t gap[] = { 0, 4, 8, 8, 4, 6 };
    ui_stack(col, gap, 6, 0, UI_SCREEN_SIZE, -1);
}

static void mmss(char out[12], int secs)
{
    if (secs < 0) secs = 0;
    snprintf(out, 12, "%02d:%02d", secs / 60 % 1000, secs % 60);
}

focus_view_t scr_focus_view(void) { return h.view; }

act_kind_t scr_focus_top_action(void)
{
    switch (h.view) {
    case FV_ACTIVE: return ACT_FOCUS_PAUSE;
    case FV_PAUSED: return ACT_FOCUS_RESUME;
    case FV_DONE: return ACT_FOCUS_STOP;
    default: return ACT_FOCUS_START;
    }
}

focus_view_t scr_focus_set(const snap_t *s, uint32_t snap_ms, uint32_t now_ms)
{
    const snap_focus_t *f = &s->focus;
    bool running = f->status == FOCUS_ACTIVE, stopwatch = !strcmp(f->mode, "stopwatch");
    int elapsed = f->elapsed_s + (running ? (int)((now_ms - snap_ms) / 1000) : 0), left = POMODORO_S - elapsed;
    focus_view_t v = f->status == FOCUS_NONE ? FV_NONE : running ? FV_ACTIVE : FV_PAUSED;
    if (v == FV_ACTIVE && !stopwatch && left <= 0) v = FV_DONE;
    h.view = v;

    mood_t mood = v == FV_ACTIVE ? MOOD_FOCUSED : v == FV_DONE ? MOOD_HAPPY : MOOD_CALM;
    if (mood != h.mood) { h.mood = mood; face_set_mood(h.face, mood); }

    char t[12];
    bool ring = v != FV_NONE && !stopwatch;
    mmss(t, v == FV_NONE ? POMODORO_S : stopwatch ? elapsed : left);
    ui_set_text(h.big, t);
    /* paused: the digits blink once a second (full, then dim) */
    lv_opa_t opa = v == FV_PAUSED && (now_ms / 1000) % 2 ? LV_OPA_30 : LV_OPA_COVER;
    if (lv_obj_get_style_text_opa(h.big, LV_PART_MAIN) != opa) lv_obj_set_style_text_opa(h.big, opa, 0);
    ui_text_color(h.big, v == FV_NONE ? UI_COLOR_MUTED : UI_COLOR_TEXT);

    ui_set_text(h.eb, v == FV_NONE ? "Focus \xC2\xB7 25 min session" : v == FV_PAUSED ? "Paused" : "Focus");
    ui_set_text(h.hint, v == FV_NONE ? "Start" : v == FV_ACTIVE ? "Pause" : v == FV_PAUSED ? "Resume" : "Done");
    ui_text_color(h.hint, v == FV_DONE ? COLOR_BREAK : COLOR_FOCUS_TEXT);
    lv_obj_set_hidden(h.eb, v == FV_DONE);
    lv_obj_set_hidden(h.big, v == FV_DONE);
    lv_obj_set_hidden(h.title, v != FV_DONE);
    lv_obj_set_hidden(h.sub, v != FV_DONE);
    lv_obj_set_hidden(h.hold, v != FV_PAUSED);

    lv_obj_set_hidden(h.ring.obj, !ring);
    if (ring) {
        int pct = v == FV_DONE ? 100 : left * 100 / POMODORO_S;
        if (v == FV_DONE || v == FV_ACTIVE) ui_arc_set(&h.ring, pct, COLOR_FOCUS, COLOR_FOCUS_TRACK);
        else ui_arc_set(&h.ring, pct, COLOR_PAUSED, COLOR_PAUSED_TRACK); /* paused: frozen and dimmed */
    }
    restack();
    return v;
}

lv_obj_t *scr_focus_create(lv_obj_t *parent)
{
    h.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    ui_arc_create(&h.ring, h.root);
    h.face = face_create(h.root, 34); /* the design's 0.34 zoom of a 300x170 face */
    h.mood = MOOD_CALM;
    h.eb = ui_label(h.root, &inter_16, COLOR_FOCUS_TEXT, 300, 1, LV_TEXT_ALIGN_CENTER);
    h.big = ui_label(h.root, &inter_clock_96, UI_COLOR_TEXT, 330, 1, LV_TEXT_ALIGN_CENTER);
    h.title = ui_label(h.root, &inter_28, UI_COLOR_TEXT, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(h.title, "Session done");
    h.sub = ui_label(h.root, &inter_16, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(h.sub, "25 min");
    h.hold = ui_label(h.root, &inter_20, UI_COLOR_TEXT2, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(h.hold, "Hold to stop");
    /* at the key: top key, right edge, as the design's ".bt.t" and the hold overlay */
    h.hint = ui_label(h.root, &inter_16, COLOR_FOCUS_TEXT, 90, 1, LV_TEXT_ALIGN_RIGHT);
    lv_obj_set_pos(h.hint, 394 - 90, 98);
    lv_label_set_text(h.eb, "");
    lv_label_set_text(h.big, "00:00");
    lv_label_set_text(h.hint, "Start");
    h.view = FV_NONE;
    return h.root;
}
