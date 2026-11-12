/* ICE card (design "10 · Safety", "Emergency card"): red ring, owner name, up to two emergency contacts and
 * a medical note. Only the fields that are filled in are shown; with no contact set the owner's phone and
 * Telegram take their place. Each contact has its relation under the name. The owner->show bits (NAME,
 * CONTACTS, MED) decide which of the three blocks appear. Deviations: no heart icon, no SOS button hint
 * (the design marks SOS as a proposal). */
#include "ui_screens_priv.h"

#define ROW_W 330
#define ROW_H 50
#define NAME_W 150
#define NOTE_W 310
#define NOTE_PAD_X 14
#define NOTE_PAD_Y 10

static struct {
    lv_obj_t *root, *head, *name, *role, *none, *note, *note_txt;
    lv_obj_t *row[2], *cname[2], *crel[2], *cphone[2];
} h;

void scr_ice_set_owner(const owner_info_t *o)
{
    bool show_name = (o->show & OWNER_SHOW_NAME) && o->name[0];
    bool show_med = (o->show & OWNER_SHOW_MED) && o->med_note[0];
    const char *cn[2] = { "", "" }, *cr[2] = { "", "" }, *cp[2] = { "", "" };
    bool fallback = false;
    if (o->show & OWNER_SHOW_CONTACTS) {
        for (int i = 0; i < 2; i++) cn[i] = o->ice_name[i], cr[i] = o->ice_rel[i], cp[i] = o->ice_phone[i];
        /* No ICE contact set (factory defaults): the owner's own phone and Telegram are the contacts. */
        const char *ph = (o->show & OWNER_SHOW_PHONE) ? o->phone : "", *tg = (o->show & OWNER_SHOW_TELEGRAM) ? o->telegram : "";
        fallback = !cn[0][0] && !cp[0][0] && !cn[1][0] && !cp[1][0] && (ph[0] || tg[0]);
        if (fallback) {
            cn[0] = ph[0] ? "Phone" : "", cp[0] = ph, cr[0] = "";
            cn[1] = tg[0] ? "Telegram" : "", cp[1] = tg, cr[1] = "";
        }
    }

    lv_label_set_text(h.name, o->name);
    lv_obj_set_hidden(h.name, !show_name);
    lv_obj_set_hidden(h.role, !show_name && !fallback);

    bool any = show_name || show_med;
    for (int i = 0; i < 2; i++) {
        bool on = cn[i][0] || cp[i][0];
        any = any || on;
        lv_label_set_text(h.cname[i], cn[i]);
        lv_label_set_text(h.crel[i], cr[i]);
        lv_label_set_text(h.cphone[i], cp[i]);
        lv_obj_set_hidden(h.crel[i], !cr[i][0]);
        lv_obj_set_hidden(h.row[i], !on);
        /* name over relation, centred as a pair; the name alone is centred by itself */
        int32_t nh = lv_obj_get_height(h.cname[i]), rh = cr[i][0] ? lv_obj_get_height(h.crel[i]) : 0;
        int32_t y = (ROW_H - nh - rh) / 2;
        lv_obj_set_pos(h.cname[i], 0, y);
        lv_obj_set_pos(h.crel[i], 0, y + nh);
    }
    /* a rule between the two contacts, not above the first */
    lv_obj_set_style_border_width(h.row[1], !lv_obj_is_hidden(h.row[0]) ? 1 : 0, 0);

    lv_label_set_text(h.note_txt, o->med_note);
    lv_obj_set_hidden(h.note, !show_med);
    int32_t th = ui_text_height(o->med_note, &inter_16, NOTE_W - 2 * NOTE_PAD_X, 3);
    lv_obj_set_height(h.note_txt, th);
    lv_obj_set_height(h.note, th + 2 * NOTE_PAD_Y);
    lv_obj_set_hidden(h.none, any);

    lv_obj_t *stack[] = { h.head, h.name, h.role, h.none, h.row[0], h.row[1], h.note };
    const uint8_t gap[] = { 0, 4, 0, 8, 6, 0, 8 };
    ui_stack(stack, gap, 7, 0, UI_SCREEN_SIZE, -1);
}

lv_obj_t *scr_ice_create(lv_obj_t *parent)
{
    h.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    ui_ring(h.root, 10, 6, UI_COLOR_DANGER);
    h.head = ui_label(h.root, &inter_16, UI_COLOR_DANGER, 200, 1, LV_TEXT_ALIGN_CENTER);
    lv_obj_set_style_text_letter_space(h.head, 1, 0);
    lv_label_set_text(h.head, "EMERGENCY");
    h.name = ui_label(h.root, &inter_28, UI_COLOR_TEXT, ROW_W, 1, LV_TEXT_ALIGN_CENTER);
    h.role = ui_label(h.root, &inter_16, UI_COLOR_SUBTLE, 200, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(h.role, "Owner");
    h.none = ui_label(h.root, &inter_20, UI_COLOR_SUBTLE, ROW_W, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(h.none, "No emergency info set");

    for (int i = 0; i < 2; i++) {
        lv_obj_t *r = h.row[i] = ui_plain(h.root, ROW_W, ROW_H);
        lv_obj_set_style_border_side(r, LV_BORDER_SIDE_TOP, 0);
        lv_obj_set_style_border_color(r, lv_color_hex(UI_COLOR_RULE), 0);
        lv_obj_set_style_border_width(r, 0, 0);
        h.cname[i] = ui_label(r, &inter_20, UI_COLOR_TEXT, NAME_W, 1, LV_TEXT_ALIGN_LEFT);
        h.crel[i] = ui_label(r, &inter_16, UI_COLOR_SUBTLE, NAME_W, 1, LV_TEXT_ALIGN_LEFT);
        h.cphone[i] = ui_label(r, &inter_16, UI_COLOR_TEXT, ROW_W - NAME_W - 10, 1, LV_TEXT_ALIGN_RIGHT);
        lv_obj_set_pos(h.cphone[i], NAME_W + 10, (ROW_H - lv_obj_get_height(h.cphone[i])) / 2);
    }

    h.note = ui_plain(h.root, NOTE_W, 40);
    lv_obj_set_style_bg_color(h.note, lv_color_hex(UI_COLOR_DANGER_BG), 0);
    lv_obj_set_style_bg_opa(h.note, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(h.note, 16, 0);
    h.note_txt = ui_label(h.note, &inter_16, UI_COLOR_TEXT, NOTE_W - 2 * NOTE_PAD_X, 3, LV_TEXT_ALIGN_LEFT);
    lv_obj_set_pos(h.note_txt, NOTE_PAD_X, NOTE_PAD_Y);
    return h.root;
}
