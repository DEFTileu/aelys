/* Toast: one rounded line low on the display ("No connection", "Didn't work - try again"), on top of every screen for 2 s.
 * No design frame; colours from the tokens (a RULE-grey pill with TEXT letters). */
#include "ui_screens_priv.h"

#define TOAST_MS 2000
#define TOAST_W 250
#define TOAST_H 36
#define TOAST_Y 372 /* its bottom corners are at radius ~210: inside the circle */

static struct { lv_obj_t *box, *label; lv_timer_t *timer; } h;

static void toast_hide(lv_timer_t *t)
{
    (void)t;
    h.timer = NULL; /* one-shot */
    lv_obj_set_hidden(h.box, true);
}

void scr_toast_show(const char *txt)
{
    ui_set_text(h.label, txt);
    lv_obj_set_hidden(h.box, false);
    lv_obj_move_foreground(h.box);
    if (h.timer) {
        lv_timer_reset(h.timer);
    } else {
        h.timer = lv_timer_create(toast_hide, TOAST_MS, NULL);
        lv_timer_set_repeat_count(h.timer, 1);
    }
}

lv_obj_t *scr_toast_create(lv_obj_t *parent)
{
    h.box = ui_plain(parent, TOAST_W, TOAST_H);
    lv_obj_set_pos(h.box, (UI_SCREEN_SIZE - TOAST_W) / 2, TOAST_Y);
    lv_obj_set_style_radius(h.box, TOAST_H / 2, 0);
    lv_obj_set_style_bg_color(h.box, lv_color_hex(UI_COLOR_RULE), 0);
    lv_obj_set_style_bg_opa(h.box, LV_OPA_COVER, 0);
    h.label = ui_label(h.box, &inter_16, UI_COLOR_TEXT, TOAST_W - 24, 1, LV_TEXT_ALIGN_CENTER);
    lv_obj_center(h.label);
    lv_obj_set_hidden(h.box, true);
    h.timer = NULL;
    return h.box;
}
