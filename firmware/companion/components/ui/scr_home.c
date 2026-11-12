/* Home: clock, Aelys face and the task orbit. Layout from the "Elis · main screen" frame of the design
 * (clock, face and agenda line in one centred column with 16 px gaps). Wi-Fi status sits below the column. */
#include <stdio.h>
#include "ui_screens_priv.h"

static struct { lv_obj_t *orbit, *clock, *face, *agenda, *wifi; } h;

void scr_home_set_time(uint8_t hour, uint8_t minute)
{
    char t[8];
    snprintf(t, sizeof t, "%02u:%02u", hour % 100u, minute % 100u);
    lv_label_set_text(h.clock, t);
}

void scr_home_set_wifi(uint8_t state)
{
    static const char *const txt[] = { "Offline", "Connecting...", "Online", "Wrong Wi-Fi password" };
    if (state > UI_WIFI_BAD_PASSWORD) return;
    lv_label_set_text(h.wifi, txt[state]);
    lv_obj_set_style_text_color(h.wifi, lv_color_hex(state == UI_WIFI_BAD_PASSWORD ? UI_COLOR_AMBER : UI_COLOR_MUTED), 0);
}

void scr_home_set_tasks(int done, int total)
{
    orbit_set(h.orbit, done, total);
    if (total <= 0) lv_label_set_text(h.agenda, "Not paired yet");
    else lv_label_set_text_fmt(h.agenda, "%d left today", total > done ? total - done : 0);
}

lv_obj_t *scr_home_create(lv_obj_t *parent)
{
    lv_obj_t *root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    h.orbit = orbit_create(root, UI_SCREEN_SIZE);
    h.clock = ui_label(root, &inter_20, UI_COLOR_TEXT2, 160, 1, LV_TEXT_ALIGN_CENTER);
    h.face = face_create(root, 107); /* the design's 300x170 face box vs 280x160 at scale 1 */
    h.agenda = ui_label(root, &inter_20, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    h.wifi = ui_label(root, &inter_16, UI_COLOR_MUTED, 240, 1, LV_TEXT_ALIGN_CENTER);
    lv_obj_set_pos(h.wifi, (UI_SCREEN_SIZE - 240) / 2, 392); /* outside the stack: the column stays centred */
    scr_home_set_wifi(UI_WIFI_OFFLINE);
    lv_label_set_text(h.clock, "--:--");
    scr_home_set_tasks(0, 0);

    lv_obj_t *col[] = { h.clock, h.face, h.agenda };
    const uint8_t gap[] = { 0, 16, 16 };
    ui_stack(col, gap, 3, 0, UI_SCREEN_SIZE, -1);
    return root;
}
