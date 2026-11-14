/* Tasks (design "Задачи · сегодня"): the first task large, a blue ring with today's progress, the eyebrow "TASKS · done / total", the
 * title (up to 3 lines), its due time and the round check that completes it (tap, or the top key hinted at its edge). When the server
 * sends today's list (snapshot tasks_today, v1.2) the title is cut to 2 lines, the check is smaller and up to 4 more tasks follow as
 * compact rows: a check, the title and the due time; a tap on a row's check completes that task. Without a list (an older server, or
 * nothing due today) it is the one-task view of the next task. After a tap the check ticks and the title is struck through until the
 * next snapshot drops the task.
 * Deviations: no sparkles (nothing to scroll, no bursts); the ring is the shared 12 px one, not the design's thin one; the rows
 * are narrow (250 px) because the round screen cuts the lower ones short. */
#include <stdio.h>
#include <string.h>
#include "ui_screens_priv.h"

#define TEXT_W 280
#define CHECK_D 64
#define HIT_PAD 24 /* the tap target is the check plus this much around it */
#define COLOR_DONE 0x5FD7A8
#define LIST_CHECK_D 44
#define LIST_HIT_PAD 10
#define ROWS (SNAP_MAX_TASKS - 1)
#define ROW_W 250
#define ROW_H 38
#define ROW_CHECK 28
#define ROW_TIME_W 54

static struct {
    lv_obj_t *root, *eb, *title, *due, *check, *lcheck, *hint;
    struct { lv_obj_t *row, *check, *title, *time; bool done; } r[ROWS];
    ui_arc_t ring;
    bool list;
} t;

static void restack(void)
{
    lv_obj_t *col[5 + ROWS] = { t.eb, t.title, t.due, t.check, t.lcheck };
    uint8_t gap[5 + ROWS] = { 0, t.list ? 8 : 10, t.list ? 2 : 6, 18, 8 };
    for (int i = 0; i < ROWS; i++) { col[5 + i] = t.r[i].row; gap[5 + i] = i ? 0 : 10; }
    ui_stack(col, gap, 5 + ROWS, 0, UI_SCREEN_SIZE, -1);
}

static void set_due(char *out, size_t n, int64_t due, int64_t now, uint32_t *color, bool row)
{
    char hm[8];
    out[0] = '\0';
    if (due <= 0) return;
    ui_fmt_hm(hm, due);
    bool late = now > 0 && due < now;
    if (row) snprintf(out, n, "%s", hm);
    else snprintf(out, n, "%s %s", late ? "Overdue" : "Due", hm);
    if (now > 0 && due - now < 3600) *color = UI_COLOR_DANGER;
}

void scr_tasks_set(const snap_t *s, int64_t now, bool offline)
{
    bool list = s->n_tasks > 0;
    const snap_task_t *big = list ? &s->tasks[0] : s->has_task ? &s->task : NULL;
    bool task = big != NULL, marked = task && ui_marked_done(big->id);
    int done = s->today_done, total = s->today_total;
    bool all_done = !task && total > 0 && done >= total;
    bool progress = total > 0 && done >= 0;
    if (progress && done < total) { /* the server will count the ticked ones too */
        int marks = list ? 0 : marked;
        for (int i = 0; list && i < s->n_tasks; i++) marks += ui_marked_done(s->tasks[i].id);
        done += marks;
        if (done > total) done = total;
    }

    char eb[40] = "TASKS", title[65] = "", due[24] = "";
    uint32_t title_color = UI_COLOR_TEXT, due_color = UI_COLOR_SUBTLE;
    if (progress) snprintf(eb, sizeof eb, "TASKS \xC2\xB7 %d / %d", done, total);
    if (task) {
        snprintf(title, sizeof title, "%s", big->title);
        if (marked) title_color = UI_COLOR_MUTED;
        set_due(due, sizeof due, big->due, now, &due_color, false);
    } else {
        title_color = all_done ? UI_COLOR_TEXT : UI_COLOR_SUBTLE;
        if (all_done) snprintf(title, sizeof title, "All done");
        else if (s->generated <= 0) snprintf(title, sizeof title, "No data yet");
        else if (offline) snprintf(title, sizeof title, "Offline");
        else snprintf(title, sizeof title, "No tasks due");
    }

    t.list = list;
    ui_set_text(t.eb, eb);
    ui_set_text(t.title, title);
    ui_text_color(t.title, title_color);
    lv_obj_set_height(t.title, ui_text_height(title, &inter_28, TEXT_W, list ? 2 : 3));
    bool strike = marked;
    if ((lv_obj_get_style_text_decor(t.title, LV_PART_MAIN) != LV_TEXT_DECOR_NONE) != strike)
        lv_obj_set_style_text_decor(t.title, strike ? LV_TEXT_DECOR_STRIKETHROUGH : LV_TEXT_DECOR_NONE, 0);
    ui_set_text(t.due, due);
    ui_text_color(t.due, due_color);
    lv_obj_set_hidden(t.due, !due[0]);

    lv_obj_t *check = list ? t.lcheck : t.check;
    lv_obj_set_hidden(t.check, list || (!task && !all_done));
    lv_obj_set_hidden(t.lcheck, !list);
    ui_check_set(check, marked || all_done, all_done ? COLOR_DONE : UI_COLOR_CHECK);
    lv_obj_set_hidden(t.hint, !task || marked);
    lv_obj_set_hidden(t.ring.obj, !progress);
    ui_arc_set(&t.ring, progress ? done * 100 / total : 0, UI_COLOR_TASK, UI_COLOR_TASK_TRACK);

    for (int i = 0; i < ROWS; i++) {
        const snap_task_t *k = i + 1 < s->n_tasks ? &s->tasks[i + 1] : NULL;
        lv_obj_set_hidden(t.r[i].row, !k);
        if (!k) continue;
        bool d = ui_marked_done(k->id);
        char tm[8] = "";
        uint32_t tc = UI_COLOR_SUBTLE;
        set_due(tm, sizeof tm, k->due, now, &tc, true);
        if (d) tc = UI_COLOR_MUTED;
        ui_set_text(t.r[i].title, k->title);
        ui_text_color(t.r[i].title, d ? UI_COLOR_MUTED : UI_COLOR_TEXT);
        ui_set_text(t.r[i].time, tm);
        ui_text_color(t.r[i].time, tc);
        ui_check_set(t.r[i].check, d, UI_COLOR_CHECK);
        if (t.r[i].done != d) {
            t.r[i].done = d;
            lv_obj_set_style_text_decor(t.r[i].title, d ? LV_TEXT_DECOR_STRIKETHROUGH : LV_TEXT_DECOR_NONE, 0);
        }
    }
    restack();
}

int scr_tasks_hit(int32_t x, int32_t y)
{
    lv_area_t a;
    lv_obj_update_layout(t.root);
    lv_obj_t *big = t.list ? t.lcheck : t.check;
    int32_t pad = t.list ? LIST_HIT_PAD : HIT_PAD;
    if (!lv_obj_is_hidden(big)) {
        lv_obj_get_coords(big, &a);
        if (x >= a.x1 - pad && x <= a.x2 + pad && y >= a.y1 - pad && y <= a.y2 + pad) return 0;
    }
    for (int i = 0; i < ROWS; i++) { /* a row's tap target: its check plus a margin, the whole row height (rows touch, so no overlap) */
        if (lv_obj_is_hidden(t.r[i].row)) continue;
        lv_obj_get_coords(t.r[i].row, &a);
        if (x >= a.x1 - LIST_HIT_PAD && x <= a.x1 + ROW_CHECK + LIST_HIT_PAD && y >= a.y1 && y <= a.y2) return i + 1;
    }
    return -1;
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
    t.lcheck = ui_check_create(t.root, LIST_CHECK_D);
    lv_obj_set_hidden(t.lcheck, true);
    for (int i = 0; i < ROWS; i++) {
        lv_obj_t *r = ui_plain(t.root, ROW_W, ROW_H);
        t.r[i].row = r;
        lv_obj_set_hidden(r, true);
        t.r[i].check = ui_check_create(r, ROW_CHECK);
        lv_obj_set_pos(t.r[i].check, 0, (ROW_H - ROW_CHECK) / 2);
        int32_t ty = (ROW_H - lv_font_get_line_height(&inter_16)) / 2;
        t.r[i].title = ui_label(r, &inter_16, UI_COLOR_TEXT, ROW_W - ROW_CHECK - ROW_TIME_W - 16, 1, LV_TEXT_ALIGN_LEFT);
        lv_obj_set_pos(t.r[i].title, ROW_CHECK + 10, ty);
        t.r[i].time = ui_label(r, &inter_16, UI_COLOR_SUBTLE, ROW_TIME_W, 1, LV_TEXT_ALIGN_RIGHT);
        lv_obj_set_pos(t.r[i].time, ROW_W - ROW_TIME_W, ty);
    }
    /* at the top key, right edge, like the Focus hint */
    t.hint = ui_label(t.root, &inter_16, UI_COLOR_TASK, 90, 1, LV_TEXT_ALIGN_RIGHT);
    lv_obj_set_pos(t.hint, 394 - 90, 98);
    lv_label_set_text(t.hint, "Done");
    scr_tasks_set(&ui_empty_snap, 0, false);
    return t.root;
}
