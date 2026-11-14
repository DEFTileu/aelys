/* Tasks (design "Задачи · сегодня"), one task at a time: the board only gets the next task, not the list. A blue ring shows
 * today's progress, the eyebrow "TASKS · done / total", then the title (up to 3 lines), its due time and the round check that
 * completes it (tap, or the top key hinted at its edge). After a tap the check ticks and the title is struck through until the
 * next snapshot brings the next task.
 * Deviations: no list of the other tasks and no sparkles (nothing to scroll, no bursts); the ring is the shared 12 px one,
 * not the design's thin one. */
#include <stdio.h>
#include <string.h>
#include "ui_screens_priv.h"

#define TEXT_W 280
#define CHECK_D 64
#define HIT_PAD 24 /* the tap target is the check plus this much around it */
#define COLOR_DONE 0x5FD7A8

static struct {
    lv_obj_t *root, *eb, *title, *due, *check, *hint;
    ui_arc_t ring;
} t;

static void restack(void)
{
    lv_obj_t *col[] = { t.eb, t.title, t.due, t.check };
    const uint8_t gap[] = { 0, 10, 6, 18 };
    ui_stack(col, gap, 4, 0, UI_SCREEN_SIZE, -1);
}

void scr_tasks_set(const snap_t *s, int64_t now, bool offline)
{
    bool task = s->has_task, marked = task && ui_marked_done(s->task.id);
    int done = s->today_done, total = s->today_total;
    bool all_done = !task && total > 0 && done >= total;
    bool progress = total > 0 && done >= 0;
    if (marked && progress && done < total) done++; /* the server will count it too */

    char eb[24] = "TASKS", title[65] = "", due[24] = "";
    uint32_t title_color = UI_COLOR_TEXT, due_color = UI_COLOR_SUBTLE;
    if (progress) snprintf(eb, sizeof eb, "TASKS \xC2\xB7 %d / %d", done, total);
    if (task) {
        snprintf(title, sizeof title, "%s", s->task.title);
        if (marked) title_color = UI_COLOR_MUTED;
        if (s->task.due > 0) {
            char hm[8];
            ui_fmt_hm(hm, s->task.due);
            bool late = now > 0 && s->task.due < now;
            snprintf(due, sizeof due, "%s %s", late ? "Overdue" : "Due", hm);
            if (now > 0 && s->task.due - now < 3600) due_color = UI_COLOR_DANGER;
        }
    } else {
        title_color = all_done ? UI_COLOR_TEXT : UI_COLOR_SUBTLE;
        if (all_done) snprintf(title, sizeof title, "All done");
        else if (s->generated <= 0) snprintf(title, sizeof title, "No data yet");
        else if (offline) snprintf(title, sizeof title, "Offline");
        else snprintf(title, sizeof title, "No tasks due");
    }

    ui_set_text(t.eb, eb);
    ui_set_text(t.title, title);
    ui_text_color(t.title, title_color);
    lv_obj_set_height(t.title, ui_text_height(title, &inter_28, TEXT_W, 3));
    bool strike = marked;
    if ((lv_obj_get_style_text_decor(t.title, LV_PART_MAIN) != LV_TEXT_DECOR_NONE) != strike)
        lv_obj_set_style_text_decor(t.title, strike ? LV_TEXT_DECOR_STRIKETHROUGH : LV_TEXT_DECOR_NONE, 0);
    ui_set_text(t.due, due);
    ui_text_color(t.due, due_color);
    lv_obj_set_hidden(t.due, !due[0]);

    lv_obj_set_hidden(t.check, !task && !all_done);
    ui_check_set(t.check, marked || all_done, all_done ? COLOR_DONE : UI_COLOR_CHECK);
    lv_obj_set_hidden(t.hint, !task || marked);
    lv_obj_set_hidden(t.ring.obj, !progress);
    ui_arc_set(&t.ring, progress ? done * 100 / total : 0, UI_COLOR_TASK, UI_COLOR_TASK_TRACK);
    restack();
}

bool scr_tasks_hit(int32_t x, int32_t y)
{
    lv_area_t a;
    lv_obj_update_layout(t.root);
    if (lv_obj_is_hidden(t.check)) return false;
    lv_obj_get_coords(t.check, &a);
    return x >= a.x1 - HIT_PAD && x <= a.x2 + HIT_PAD && y >= a.y1 - HIT_PAD && y <= a.y2 + HIT_PAD;
}

lv_obj_t *scr_tasks_create(lv_obj_t *parent)
{
    t.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    ui_arc_create(&t.ring, t.root);
    lv_obj_set_hidden(t.ring.obj, true);
    t.eb = ui_label(t.root, &inter_16, UI_COLOR_TASK, 200, 1, LV_TEXT_ALIGN_CENTER);
    t.title = ui_label(t.root, &inter_28, UI_COLOR_TEXT, TEXT_W, 3, LV_TEXT_ALIGN_CENTER);
    t.due = ui_label(t.root, &inter_20, UI_COLOR_SUBTLE, TEXT_W, 1, LV_TEXT_ALIGN_CENTER);
    t.check = ui_check_create(t.root, CHECK_D);
    /* at the top key, right edge, like the Focus hint */
    t.hint = ui_label(t.root, &inter_16, UI_COLOR_TASK, 90, 1, LV_TEXT_ALIGN_RIGHT);
    lv_obj_set_pos(t.hint, 394 - 90, 98);
    lv_label_set_text(t.hint, "Done");
    scr_tasks_set(&(snap_t){ 0 }, 0, false);
    return t.root;
}
