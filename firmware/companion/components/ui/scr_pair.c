/* Pairing (design "Сопряжение · код" and "Paired"): "Pair with Aelys", the six SAS digits the owner compares
 * with Aelys web and "Confirm this code in Aelys web", then a "Paired / Syncing your day" card. One screen object with two views, switched by the events. */
#include <string.h>
#include "ui_screens_priv.h"

static struct { lv_obj_t *root, *face, *code, *title, *sub; } h;

static void restack(void)
{
    lv_obj_t *col[] = { h.face, h.title, h.code, h.sub };
    const uint8_t gap[] = { 0, 8, 6, 6 };
    ui_stack(col, gap, 4, 0, UI_SCREEN_SIZE, -1);
}

bool scr_pair_set_code(const char *digits)
{
    for (int i = 0; i < 6; i++)
        if (digits[i] < '0' || digits[i] > '9') return false;
    char t[7];
    memcpy(t, digits, 6);
    t[6] = '\0';
    lv_label_set_text(h.code, t);
    lv_obj_set_hidden(h.code, false);
    face_set_mood(h.face, MOOD_CURIOUS);
    lv_label_set_text(h.title, "Pair with Aelys");
    lv_label_set_text(h.sub, "Confirm this code in Aelys web");
    restack();
    return true;
}

void scr_pair_set_done(void)
{
    lv_obj_set_hidden(h.code, true);
    face_set_mood(h.face, MOOD_HAPPY);
    lv_label_set_text(h.title, "Paired");
    lv_label_set_text(h.sub, "Syncing your day");
    restack();
}

lv_obj_t *scr_pair_create(lv_obj_t *parent)
{
    h.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    h.face = face_create(h.root, 50);
    h.code = ui_label(h.root, &inter_clock_96, UI_COLOR_ACCENT, 400, 1, LV_TEXT_ALIGN_CENTER); /* six digits + spacing are up to 392 px; narrower clips to "..." */
    lv_obj_set_style_text_letter_space(h.code, 4, 0);
    h.title = ui_label(h.root, &inter_20, UI_COLOR_TEXT, 330, 1, LV_TEXT_ALIGN_CENTER);
    h.sub = ui_label(h.root, &inter_16, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    scr_pair_set_done(); /* placeholder content: the events fill it in before it is ever shown */
    return h.root;
}
