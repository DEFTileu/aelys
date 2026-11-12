/* Lost mode (design "10 · Safety", "Lost mode"): amber ring, sad Aelys, "This Aelys is lost", the owner's
 * message, QR to the contact link and name / phone / Telegram. Empty fields are left out.
 * Deviations: no phone/send icons (no icon font), no pulsing ring (no opacity layers), no second quote line
 * (owner_info_t has one message). */
#include <string.h>
#include "ui_screens_priv.h"

#define QR_SIZE 104
#define COL_W 190
#define COL_X (QR_SIZE + 16)
#define MSG_W 300

static struct { lv_obj_t *root, *face, *title, *msg, *row, *qr, *name, *phone, *tg; } h;

void scr_lost_set_owner(const owner_info_t *o)
{
    lv_label_set_text(h.name, o->name);
    lv_label_set_text(h.phone, o->phone);
    lv_label_set_text(h.tg, o->telegram);
    lv_obj_set_hidden(h.name, !o->name[0]);
    lv_obj_set_hidden(h.phone, !o->phone[0]);
    lv_obj_set_hidden(h.tg, !o->telegram[0]);
    bool qr = o->qr_url[0] != 0 && lv_qrcode_update(h.qr, o->qr_url, (uint32_t)strlen(o->qr_url)) == LV_RESULT_OK;
    lv_obj_set_hidden(h.qr, !qr);
    bool text = o->name[0] || o->phone[0] || o->telegram[0];
    lv_obj_t *col[] = { h.name, h.phone, h.tg };
    const uint8_t cgap[] = { 0, 6, 6 };
    ui_stack(col, cgap, 3, 0, QR_SIZE, qr ? COL_X : 0);
    lv_obj_set_width(h.row, (qr ? COL_X : 0) + (text ? COL_W : 0));
    lv_obj_set_hidden(h.row, !qr && !text);

    lv_label_set_text(h.msg, o->message);
    lv_obj_set_hidden(h.msg, !o->message[0]);
    lv_obj_set_height(h.msg, ui_text_height(o->message, &inter_16, MSG_W, 2));

    lv_obj_t *stack[] = { h.face, h.title, h.msg, h.row };
    const uint8_t gap[] = { 0, 4, 2, 10 };
    ui_stack(stack, gap, 4, 0, UI_SCREEN_SIZE, -1);
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
    return h.root;
}
