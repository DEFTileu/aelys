/* Today (design "Today · обзор"): date, clock, then up to three rows - the next task (round box: tap completes it),
 * the next event and the unread count with "{done} / {total} done" - inside a day-progress ring.
 * Deviations: the bell icon is a small accent dot (no icon font); the colon does not blink; the date is not upper-cased. */
#define _POSIX_C_SOURCE 200809L /* localtime_r, setenv, tzset under -std=c11 */
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "ui_screens_priv.h"

#define ROW_W 316
#define ROW_H 50
#define COL_TEXT 38 /* x of the row titles: after the 26 px round box */
#define COLOR_TASK 0x7FA8F5 /* module colours of the design: tasks blue, calendar coral */
#define COLOR_TASK_TRACK 0x141B2A
#define COLOR_EVENT 0xFF8A84

static struct {
    lv_obj_t *root, *date, *clock;
    ui_arc_t ring;
    struct { lv_obj_t *row, *mark, *title, *right; } task, event, unread;
    uint8_t hh, mm;
} h;

static lv_obj_t *new_row(lv_obj_t *parent, bool rule)
{
    lv_obj_t *r = ui_plain(parent, ROW_W, ROW_H);
    if (rule) {
        lv_obj_set_style_border_side(r, LV_BORDER_SIDE_TOP, 0);
        lv_obj_set_style_border_width(r, 1, 0);
        lv_obj_set_style_border_color(r, lv_color_hex(UI_COLOR_RULE), 0);
    }
    return r;
}

static lv_obj_t *dot(lv_obj_t *row, uint32_t color)
{
    lv_obj_t *d = ui_plain(row, 10, 10);
    lv_obj_set_pos(d, 8, 20);
    lv_obj_set_style_radius(d, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(d, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(d, lv_color_hex(color), 0);
    return d;
}

static void fill_row(lv_obj_t *row, lv_obj_t **title, lv_obj_t **right, int32_t right_w)
{
    *title = ui_label(row, &inter_20, UI_COLOR_TEXT, ROW_W - COL_TEXT - right_w - 8, 1, LV_TEXT_ALIGN_LEFT);
    lv_obj_set_pos(*title, COL_TEXT, (ROW_H - lv_obj_get_height(*title)) / 2);
    *right = ui_label(row, &inter_16, UI_COLOR_SUBTLE, right_w, 1, LV_TEXT_ALIGN_RIGHT);
    lv_obj_set_pos(*right, ROW_W - right_w, (ROW_H - lv_obj_get_height(*right)) / 2);
}

static void restack(void)
{
    lv_obj_t *col[] = { h.date, h.clock, h.task.row, h.event.row, h.unread.row };
    const uint8_t gap[] = { 0, 4, 12, 0, 0 };
    ui_stack(col, gap, 5, 0, UI_SCREEN_SIZE, -1);
}

void scr_today_set_time(uint8_t hour, uint8_t minute)
{
    h.hh = hour; h.mm = minute;
    char t[8];
    if (hour > 23) snprintf(t, sizeof t, "--:--");
    else snprintf(t, sizeof t, "%02u:%02u", hour, minute % 100u);
    ui_set_text(h.clock, t);
}

static void set_row_time(lv_obj_t *label, int64_t epoch, bool soon)
{
    char t[8];
    ui_fmt_hm(t, epoch);
    ui_set_text(label, epoch > 0 ? t : "");
    ui_text_color(label, soon ? UI_COLOR_DANGER : UI_COLOR_SUBTLE);
}

void scr_today_set(const snap_t *s, int64_t now)
{
    char t[32];
    time_t tt = (time_t)now;
    struct tm tm;
    if (now > 0 && localtime_r(&tt, &tm) && strftime(t, sizeof t, "%a, %b ", &tm)) {
        char day[8];
        snprintf(day, sizeof day, "%d", tm.tm_mday);
        strncat(t, day, sizeof t - strlen(t) - 1); /* no leading zero: "Nov 5", not "Nov 05" */
    } else {
        t[0] = 0;
    }
    ui_set_text(h.date, t);
    lv_obj_set_hidden(h.date, !t[0]);

    lv_obj_set_hidden(h.task.row, !s->has_task);
    if (s->has_task) {
        bool done = ui_marked_done(s->task.id);
        ui_check_set(h.task.mark, done, 0x6A4CF2);
        ui_set_text(h.task.title, s->task.title);
        ui_text_color(h.task.title, done ? UI_COLOR_MUTED : UI_COLOR_TEXT);
        if ((lv_obj_get_style_text_decor(h.task.title, LV_PART_MAIN) != LV_TEXT_DECOR_NONE) != done)
            lv_obj_set_style_text_decor(h.task.title, done ? LV_TEXT_DECOR_STRIKETHROUGH : LV_TEXT_DECOR_NONE, 0);
        set_row_time(h.task.right, s->task.due, s->task.due > 0 && now > 0 && s->task.due - now < 3600);
    }
    lv_obj_set_hidden(h.event.row, !s->has_event);
    if (s->has_event) {
        ui_set_text(h.event.title, s->event.title);
        if (s->event.all_day) { ui_set_text(h.event.right, "All day"); ui_text_color(h.event.right, UI_COLOR_SUBTLE); }
        else set_row_time(h.event.right, s->event.starts, false);
    }
    snprintf(t, sizeof t, "%d new", s->unread > 0 ? s->unread : 0);
    ui_set_text(h.unread.title, t);
    bool prog = s->today_total > 0;
    if (prog) snprintf(t, sizeof t, "%d / %d done", s->today_done, s->today_total);
    ui_set_text(h.unread.right, prog ? t : "");
    lv_obj_set_hidden(h.ring.obj, !prog);
    ui_arc_set(&h.ring, prog ? s->today_done * 100 / s->today_total : 0, COLOR_TASK, COLOR_TASK_TRACK);
    restack();
}

tap_hit_t scr_today_hit(int32_t x, int32_t y)
{
    lv_obj_update_layout(h.root);
    lv_obj_t *const rows[] = { h.task.row, h.unread.row };
    const tap_hit_t hits[] = { TAP_ROW, TAP_UNREAD_ROW };
    for (int i = 0; i < 2; i++) {
        lv_area_t a;
        if (lv_obj_is_hidden(rows[i])) continue;
        lv_obj_get_coords(rows[i], &a);
        if (x >= a.x1 && x <= a.x2 && y >= a.y1 && y <= a.y2) return hits[i];
    }
    return TAP_OUTSIDE;
}

lv_obj_t *scr_today_create(lv_obj_t *parent)
{
    h.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    ui_arc_create(&h.ring, h.root);
    lv_obj_set_hidden(h.ring.obj, true);
    h.date = ui_label(h.root, &inter_16, UI_COLOR_SUBTLE, 260, 1, LV_TEXT_ALIGN_CENTER);
    h.clock = ui_label(h.root, &inter_clock_96, UI_COLOR_TEXT, 330, 1, LV_TEXT_ALIGN_CENTER);

    h.task.row = new_row(h.root, false);
    h.task.mark = ui_check_create(h.task.row, 26);
    lv_obj_set_pos(h.task.mark, 0, 12);
    fill_row(h.task.row, &h.task.title, &h.task.right, 60);

    h.event.row = new_row(h.root, true);
    dot(h.event.row, COLOR_EVENT);
    fill_row(h.event.row, &h.event.title, &h.event.right, 70);

    h.unread.row = new_row(h.root, true);
    dot(h.unread.row, UI_COLOR_ACCENT);
    fill_row(h.unread.row, &h.unread.title, &h.unread.right, 140);
    lv_obj_set_width(h.unread.title, 110);

    scr_today_set_time(255, 0);
    restack();
    return h.root;
}
