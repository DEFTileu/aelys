/* Lost mode (design "10 · Safety", "Lost mode"): amber ring, sad Aelys, "This Aelys is lost", the owner's
 * message, QR to the contact link and name / phone / Telegram / email. Empty fields and fields whose
 * owner->show bit is clear are left out.
 * Design "Режим потери · нажата кнопка": a key or a touch shows a hint pill for 2 s (scr_lost_show_hint); it is part of this
 * screen, not the generic toast (which never appears over lost mode).
 * Deviations: no phone/send icons and no lock icon in the hint (no icon font), no pulsing ring (no opacity layers),
 * no second quote line (owner_info_t has one message). */
#include <string.h>
#include "ui_screens_priv.h"

#define QR_SIZE 104
#define COL_W 190
#define COL_X (QR_SIZE + 16)
#define MSG_W 300
#define HINT_MS 2000
#define HINT_W 280
#define HINT_PAD 18

static struct { lv_obj_t *root, *face, *title, *msg, *row, *qr, *name, *phone, *tg, *email, *hint; lv_timer_t *hint_timer; } h;

void scr_lost_set_owner(const owner_info_t *o)
{
    const char *txt[] = { o->name, o->phone, o->telegram, o->email };
    const uint8_t bit[] = { OWNER_SHOW_NAME, OWNER_SHOW_PHONE, OWNER_SHOW_TELEGRAM, OWNER_SHOW_EMAIL };
    lv_obj_t *col[] = { h.name, h.phone, h.tg, h.email };
    bool text = false;
    for (int i = 0; i < 4; i++) {
        bool on = txt[i][0] && (o->show & bit[i]);
        lv_label_set_text(col[i], txt[i]);
        lv_obj_set_hidden(col[i], !on);
        text = text || on;
    }
    bool qr = o->qr != QR_NONE && o->qr_url[0] != 0 &&
              lv_qrcode_update(h.qr, o->qr_url, (uint32_t)strlen(o->qr_url)) == LV_RESULT_OK;
    lv_obj_set_hidden(h.qr, !qr);
    const uint8_t cgap[] = { 0, 6, 6, 6 };
    ui_stack(col, cgap, 4, 0, QR_SIZE, qr ? COL_X : 0);
    lv_obj_set_width(h.row, (qr ? COL_X : 0) + (text ? COL_W : 0));
    lv_obj_set_hidden(h.row, !qr && !text);

    lv_label_set_text(h.msg, o->message);
    lv_obj_set_hidden(h.msg, !o->message[0]);
    lv_obj_set_height(h.msg, ui_text_height(o->message, &inter_16, MSG_W, 2));

    lv_obj_t *stack[] = { h.face, h.title, h.msg, h.row };
    const uint8_t gap[] = { 0, 4, 2, 10 };
    ui_stack(stack, gap, 4, 0, UI_SCREEN_SIZE, -1);
}

static void hint_timeout(lv_timer_t *t)
{
    (void)t;
    h.hint_timer = NULL; /* one-shot */
    lv_obj_set_hidden(h.hint, true);
}

void scr_lost_hide_hint(void)
{
    if (h.hint_timer) { lv_timer_delete(h.hint_timer); h.hint_timer = NULL; }
    lv_obj_set_hidden(h.hint, true);
}

void scr_lost_show_hint(void)
{
    lv_obj_set_hidden(h.hint, false);
    if (h.hint_timer) {
        lv_timer_reset(h.hint_timer);
    } else {
        h.hint_timer = lv_timer_create(hint_timeout, HINT_MS, NULL);
        lv_timer_set_repeat_count(h.hint_timer, 1);
    }
}

lv_obj_t *scr_lost_create(lv_obj_t *parent)
{
    h.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    ui_ring(h.root, 10, 6, UI_COLOR_AMBER);
    h.face = face_create(h.root, 36);
    face_set_mood(h.face, MOOD_SAD);
    h.title = ui_label(h.root, &inter_24, UI_COLOR_TEXT, MSG_W, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(h.title, "This Aelys is lost");
    h.msg = ui_label(h.root, &inter_16, UI_COLOR_SUBTLE, MSG_W, 2, LV_TEXT_ALIGN_CENTER);

    h.row = ui_plain(h.root, COL_X + COL_W, QR_SIZE);
    h.qr = lv_qrcode_create(h.row);
    lv_qrcode_set_size(h.qr, QR_SIZE);
    lv_qrcode_set_dark_color(h.qr, lv_color_hex(UI_COLOR_BG));
    lv_qrcode_set_light_color(h.qr, lv_color_hex(UI_COLOR_QR_LIGHT));
    lv_qrcode_set_quiet_zone(h.qr, true);
    lv_obj_set_pos(h.qr, 0, 0);
    h.name = ui_label(h.row, &inter_20, UI_COLOR_TEXT, COL_W, 1, LV_TEXT_ALIGN_LEFT);
    h.phone = ui_label(h.row, &inter_16, UI_COLOR_TEXT2, COL_W, 1, LV_TEXT_ALIGN_LEFT);
    h.tg = ui_label(h.row, &inter_16, UI_COLOR_TEXT2, COL_W, 1, LV_TEXT_ALIGN_LEFT);
    h.email = ui_label(h.row, &inter_16, UI_COLOR_TEXT2, COL_W, 1, LV_TEXT_ALIGN_LEFT);

    const char *txt = "Only the owner can turn this off";
    int32_t th = ui_text_height(txt, &inter_16, HINT_W - 2 * HINT_PAD, 2);
    h.hint = ui_plain(h.root, HINT_W, th + 28);
    lv_obj_set_pos(h.hint, (UI_SCREEN_SIZE - HINT_W) / 2, 58);
    lv_obj_set_style_radius(h.hint, 24, 0);
    lv_obj_set_style_bg_color(h.hint, lv_color_hex(0x1C1A24), 0);
    lv_obj_set_style_bg_opa(h.hint, LV_OPA_COVER, 0);
    lv_obj_t *l = ui_label(h.hint, &inter_16, UI_COLOR_TEXT, HINT_W - 2 * HINT_PAD, 2, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(l, txt);
    lv_obj_set_height(l, th);
    lv_obj_center(l);
    lv_obj_set_hidden(h.hint, true);
    h.hint_timer = NULL;
    return h.root;
}
