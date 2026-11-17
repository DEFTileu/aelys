/* Power cards (design "Зарядка" and "Батарея низкая"), over the everyday screens for a few seconds: when the charger goes in, a green
 * ring at the charge, Aelys dozing, the percent and the time to full; when the battery falls under 15 %, a red ring that blinks, Aelys
 * worn out, "12% left" and "Plug me in". A tap or a key closes the card (screens.c).
 * Deviations: no zap or battery icon (no icon font); the percent is the 96 px clock digits with a 40 px "%"; the charging ring does not
 * pulse; the brightness is not lowered on a low battery. */
#include <stdio.h>
#include <string.h>
#include "ui_screens_priv.h"

#define COLOR_CHARGE 0x5FD7A8
#define COLOR_CHARGE_TRACK 0x13241E
#define COLOR_LOW 0xFF8A84
#define COLOR_LOW_TRACK 0x2A1618
#define BLINK_MS 500
#define DIGITS_H 70 /* cap height of inter_clock_96 */

static struct {
    lv_obj_t *root, *doze, *worn, *num, *digits, *sign, *title, *sub;
    lv_timer_t *blink;
    ui_arc_t ring;
    bool low, lit;
    int pct;
} p;

static void blink_cb(lv_timer_t *t)
{
    (void)t;
    p.lit = !p.lit;
    ui_arc_set(&p.ring, p.pct, p.lit ? COLOR_LOW : COLOR_LOW_TRACK, COLOR_LOW_TRACK);
}

/* "64" in the clock digits and "%" in the 40 px font, bottoms aligned, centred as one group. */
static void set_number(int pct)
{
    char d[8];
    lv_point_t a, b;
    snprintf(d, sizeof d, "%d", pct);
    ui_set_text(p.digits, d);
    lv_text_get_size(&a, d, &inter_clock_96, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    lv_text_get_size(&b, "%", &inter_40, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    int32_t x = (lv_obj_get_width(p.num) - a.x - 4 - b.x) / 2;
    int32_t top = lv_font_get_line_height(&inter_clock_96) - inter_clock_96.base_line - DIGITS_H;
    lv_obj_set_width(p.digits, a.x + 8);
    lv_obj_set_pos(p.digits, x, -top);
    int32_t sign_base = lv_font_get_line_height(&inter_40) - inter_40.base_line; /* the "%" baseline on the digits' */
    lv_obj_set_pos(p.sign, x + a.x + 4, DIGITS_H - sign_base);
}

void scr_power_show(bool low, int pct, const char *line)
{
    p.low = low;
    p.pct = pct;
    lv_obj_set_hidden(p.doze, low);
    lv_obj_set_hidden(p.worn, !low);
    lv_obj_set_hidden(p.num, low);
    lv_obj_set_hidden(p.title, !low);
    char t[24];
    if (low) {
        snprintf(t, sizeof t, "%d%% left", pct);
        ui_set_text(p.title, t);
        ui_set_text(p.sub, "Plug me in");
        p.lit = true;
        ui_arc_set(&p.ring, pct, COLOR_LOW, COLOR_LOW_TRACK);
        if (!p.blink) p.blink = lv_timer_create(blink_cb, BLINK_MS, NULL);
    } else {
        set_number(pct);
        ui_set_text(p.sub, line ? line : "Charging");
        ui_arc_set(&p.ring, pct, COLOR_CHARGE, COLOR_CHARGE_TRACK);
        if (p.blink) { lv_timer_delete(p.blink); p.blink = NULL; }
    }
    lv_obj_t *col[3];
    uint8_t gap[3] = { 0, 10, low ? 8 : 16 };
    col[0] = low ? p.worn : p.doze;
    col[1] = low ? p.title : p.num;
    col[2] = p.sub;
    ui_stack(col, gap, 3, 0, UI_SCREEN_SIZE, -1);
    lv_obj_set_hidden(p.root, false);
}

void scr_power_hide(void)
{
    if (p.blink) { lv_timer_delete(p.blink); p.blink = NULL; }
    lv_obj_set_hidden(p.root, true);
}

bool scr_power_visible(void) { return p.root && !lv_obj_is_hidden(p.root); }

lv_obj_t *scr_power_create(lv_obj_t *parent)
{
    if (p.blink) lv_timer_delete(p.blink); /* a repeated setup (host tests) */
    memset(&p, 0, sizeof p);
    p.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    lv_obj_set_style_bg_color(p.root, lv_color_hex(UI_COLOR_BG), 0);
    lv_obj_set_style_bg_opa(p.root, LV_OPA_COVER, 0); /* covers whatever screen is up */
    ui_arc_create(&p.ring, p.root);
    p.doze = face_create(p.root, 45); /* the design's 0.45 */
    face_set_mood(p.doze, MOOD_CHARGING);
    p.worn = face_create(p.root, 62); /* the design's 0.62 */
    face_set_mood(p.worn, MOOD_EXHAUSTED);
    p.num = ui_plain(p.root, 300, DIGITS_H);
    p.digits = ui_label(p.num, &inter_clock_96, UI_COLOR_TEXT, 200, 1, LV_TEXT_ALIGN_LEFT);
    p.sign = ui_label(p.num, &inter_40, UI_COLOR_TEXT, 40, 1, LV_TEXT_ALIGN_LEFT);
    lv_label_set_text(p.sign, "%");
    p.title = ui_label(p.root, &inter_24, UI_COLOR_TEXT, 300, 1, LV_TEXT_ALIGN_CENTER);
    p.sub = ui_label(p.root, &inter_20, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_obj_set_hidden(p.root, true);
    return p.root;
}
