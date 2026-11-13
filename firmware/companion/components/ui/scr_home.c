/* Home: clock, Aelys face and the task orbit. Layout from the "Elis · main screen" frame of the design
 * (clock, face and agenda line in one centred column with 16 px gaps). Wi-Fi status sits below the column.
 * When the link is down it turns into the design's "Нет связи" frame: sleepy-eyed Aelys, "Offline", the time of the data
 * on screen and the tasks line. Deviation: no "Retry" hint (the top key has no retry action). */
#include <stdio.h>
#include <string.h>
#include "ui_screens_priv.h"

static struct {
    lv_obj_t *orbit, *clock, *face, *agenda, *hint, *wifi;
    lv_obj_t *off_face, *off_title, *off_since, *off_tasks;
    int done, total;
    bool welcome, paired, offline;
    uint8_t wifi_state; /* ui_wifi_state_t */
    mood_t mood, off_mood;
} h;

lv_obj_t *scr_home_root(void) { return h.face ? lv_obj_get_parent(h.face) : NULL; }

mood_t scr_home_mood(void) { return h.mood; }
mood_t scr_home_offline_mood(void) { return h.off_mood; }

void scr_home_set_time(uint8_t hour, uint8_t minute)
{
    char t[8];
    snprintf(t, sizeof t, "%02u:%02u", hour % 100u, minute % 100u);
    lv_label_set_text(h.clock, t);
}

/* The Wi-Fi line stays on the Offline view when it says something the view does not: "Connecting..." or "Wrong Wi-Fi password".
 * "Offline" / "Online" there would only repeat or contradict the title. */
static void wifi_show(void)
{
    bool useful = h.wifi_state == UI_WIFI_CONNECTING || h.wifi_state == UI_WIFI_BAD_PASSWORD;
    lv_obj_set_hidden(h.wifi, h.offline && !useful);
}

void scr_home_set_wifi(uint8_t state)
{
    static const char *const txt[] = { "Offline", "Connecting...", "Online", "Wrong Wi-Fi password" };
    if (state > UI_WIFI_BAD_PASSWORD) return;
    h.wifi_state = state;
    lv_label_set_text(h.wifi, txt[state]);
    wifi_show();
    lv_obj_set_style_text_color(h.wifi, lv_color_hex(state == UI_WIFI_BAD_PASSWORD ? UI_COLOR_AMBER : UI_COLOR_MUTED), 0);
}

static void restack(void)
{
    lv_obj_t *col[] = { h.clock, h.face, h.agenda, h.hint };
    const uint8_t gap[] = { 0, 16, 16, 4 };
    ui_stack(col, gap, 4, 0, UI_SCREEN_SIZE, -1);
    lv_obj_set_y(h.wifi, h.welcome ? 420 : 392);
}

void scr_home_set_paired(bool on)
{
    h.paired = on;
    scr_home_set_tasks(h.done, h.total);
}

void scr_home_set_welcome(bool on)
{
    if (on == h.welcome) return;
    h.welcome = on;
    lv_obj_set_hidden(h.hint, !on);
    scr_home_set_tasks(h.done, h.total);
    restack();
}

void scr_home_set_tasks(int done, int total)
{
    h.done = done; h.total = total;
    orbit_set(h.orbit, done, total);
    if (h.welcome) lv_label_set_text(h.agenda, "Hi, I'm Aelys");
    else if (total <= 0) lv_label_set_text(h.agenda, h.paired ? "" : "Not paired yet");
    else lv_label_set_text_fmt(h.agenda, "%d left today", total > done ? total - done : 0);
}

static void offline_restack(void)
{
    lv_obj_t *col[] = { h.off_face, h.off_title, h.off_since, h.off_tasks };
    const uint8_t gap[] = { 0, 6, 6, 8 };
    ui_stack(col, gap, 4, 0, UI_SCREEN_SIZE, -1);
}

void scr_home_set_snap(const snap_t *s, int64_t now, mood_t mood, bool offline)
{
    if (mood != h.mood) { h.mood = mood; face_set_mood(h.face, mood); }
    bool known = s->today_total > 0;
    int done = known ? s->today_done : 0, total = known ? s->today_total : 0;
    if (done != h.done || total != h.total) scr_home_set_tasks(done, total); /* the orbit restyles its dots: only on a change */

    offline = offline && h.paired && !h.welcome;
    if (offline && mood != h.off_mood) { h.off_mood = mood; face_set_mood(h.off_face, mood); }
    if (offline != h.offline) {
        h.offline = offline;
        lv_obj_t *normal[] = { h.orbit, h.clock, h.face, h.agenda };
        for (unsigned i = 0; i < sizeof normal / sizeof *normal; i++) lv_obj_set_hidden(normal[i], offline);
        lv_obj_t *off[] = { h.off_face, h.off_title, h.off_since, h.off_tasks };
        for (unsigned i = 0; i < sizeof off / sizeof *off; i++) lv_obj_set_hidden(off[i], !offline);
        wifi_show();
        if (!offline) restack();
    }
    if (!offline) return;
    char t[64], hm[8];
    ui_fmt_hm(hm, s->generated);
    snprintf(t, sizeof t, "Showing data from %s", hm);
    ui_set_text(h.off_since, t);
    lv_obj_set_hidden(h.off_since, s->generated <= 0);
    /* "5 / 8 tasks \xC2\xB7 next at 16:00": next = the earlier of the next task's due time and the next event's start */
    int64_t next = 0;
    if (s->has_task && s->task.due > 0) next = s->task.due;
    if (s->has_event && s->event.starts > 0 && (!next || s->event.starts < next)) next = s->event.starts;
    t[0] = 0;
    if (known) snprintf(t, sizeof t, "%d / %d tasks", s->today_done, s->today_total);
    if (next > 0) {
        ui_fmt_hm(hm, next);
        size_t n = strlen(t);
        snprintf(t + n, sizeof t - n, "%snext at %s", n ? " \xC2\xB7 " : "", hm);
    }
    ui_set_text(h.off_tasks, t);
    lv_obj_set_hidden(h.off_tasks, !t[0]);
    (void)now;
    offline_restack();
}

lv_obj_t *scr_home_create(lv_obj_t *parent)
{
    lv_obj_t *root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    h.orbit = orbit_create(root, UI_SCREEN_SIZE);
    h.clock = ui_label(root, &inter_20, UI_COLOR_TEXT2, 160, 1, LV_TEXT_ALIGN_CENTER);
    h.mood = MOOD_CALM;
    h.face = face_create(root, 130); /* 390x221 box, approximately 91x130 eyes */
    h.agenda = ui_label(root, &inter_20, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    h.hint = ui_label(root, &inter_16, UI_COLOR_SUBTLE, 260, 2, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(h.hint, "Connect me by USB and open Aelys web");
    lv_obj_set_hidden(h.hint, true);
    h.wifi = ui_label(root, &inter_16, UI_COLOR_MUTED, 240, 1, LV_TEXT_ALIGN_CENTER);
    lv_obj_set_pos(h.wifi, (UI_SCREEN_SIZE - 240) / 2, 392); /* outside the stack: the column stays centred */
    h.off_face = face_create(root, 70); /* the design's 0.7 zoom of a 300x170 face */
    face_set_mood(h.off_face, MOOD_OFFLINE);
    h.off_mood = MOOD_OFFLINE;
    h.off_title = ui_label(root, &inter_24, UI_COLOR_TEXT, 330, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(h.off_title, "Offline");
    h.off_since = ui_label(root, &inter_16, UI_COLOR_SUBTLE, 330, 1, LV_TEXT_ALIGN_CENTER);
    h.off_tasks = ui_label(root, &inter_16, UI_COLOR_MUTED, 330, 1, LV_TEXT_ALIGN_CENTER);
    lv_obj_t *off[] = { h.off_face, h.off_title, h.off_since, h.off_tasks };
    for (unsigned i = 0; i < sizeof off / sizeof *off; i++) lv_obj_set_hidden(off[i], true);
    scr_home_set_wifi(UI_WIFI_OFFLINE);
    lv_label_set_text(h.clock, "--:--");
    scr_home_set_tasks(0, 0);

    restack();
    return root;
}
