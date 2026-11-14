/* New-notification pop-up (designs "Уведомление · всплывает" and "Уведомление · Telegram"): a rounded card near the top, over any
 * everyday screen. A tile in the kind's colour, the eyebrow ("Tasks", "Calendar", "Focus") and the title; a thin bar along the bottom
 * runs out over NOTICE_MS. Privacy: only task.*, calendar.* and focus.* notices show their title; anything else (Telegram) shows the
 * app name and a count, never a name or text. One lv_timer at 1 s, alive only while the card is up.
 * Deviations: a colour dot in the tile instead of the module icon (no icon font); the bar steps once a second; no slide-in and no
 * swipe-up to hide (the key hides it, a touch opens the Inbox). */
#include <stdio.h>
#include <string.h>
#include "ui_screens_priv.h"

#define NOTICE_MS 6000
#define BOX_X 93
#define BOX_Y 58
#define BOX_W 280
#define BOX_H 76
#define PAD_X 18
#define TILE 42
#define BAR_W (BOX_W - 2 * PAD_X)
#define HIT_PAD 12
#define COLOR_BOX 0x1C1A24
#define COLOR_BAR 0x4A4554
#define COLOR_TG_TILE 0x16141C
#define COLOR_TG_DOT 0xCBC6D5

static struct { lv_obj_t *box, *tile, *dot, *eb, *title, *bar; lv_timer_t *timer; uint32_t t0; } n;

static bool is_telegram(const char *kind)
{
    static const char t[] = "telegram";
    for (unsigned i = 0; i < sizeof t - 1; i++)
        if ((kind[i] | 0x20) != t[i]) return false; /* ASCII case-fold; a NUL never matches a letter */
    return true;
}

void scr_notice_hide(void)
{
    if (n.timer) { lv_timer_delete(n.timer); n.timer = NULL; }
    lv_obj_set_hidden(n.box, true);
}

bool scr_notice_visible(void) { return !lv_obj_is_hidden(n.box); }

/* wall time, not a count of ticks: a late tick must not stretch the 6 s */
static void bar_set(uint32_t elapsed) { lv_obj_set_width(n.bar, BAR_W * (int32_t)(NOTICE_MS - elapsed) / NOTICE_MS); }

static void tick(lv_timer_t *t)
{
    (void)t;
    uint32_t e = lv_tick_elaps(n.t0);
    if (e >= NOTICE_MS) { scr_notice_hide(); return; }
    bar_set(e);
}

void scr_notice_show(const snap_notice_t *no, int count)
{
    const char *name = "";
    uint32_t bg = COLOR_TG_TILE, fg = COLOR_TG_DOT, eb = UI_COLOR_SUBTLE;
    char line[72];
    if (ui_notice_style(no->kind, &name, &bg, &fg)) {
        eb = fg;
        snprintf(line, sizeof line, "%s", no->title);
    } else {
        name = is_telegram(no->kind) ? "Telegram" : "Notification";
        if (count < 1) count = 1;
        snprintf(line, sizeof line, "%d new %s", count, count == 1 ? "message" : "messages");
    }
    ui_set_text(n.eb, name);
    ui_text_color(n.eb, eb);
    ui_set_text(n.title, line);
    lv_obj_set_style_bg_color(n.tile, lv_color_hex(bg), 0);
    lv_obj_set_style_bg_color(n.dot, lv_color_hex(fg), 0);
    n.t0 = lv_tick_get();
    bar_set(0);
    lv_obj_set_hidden(n.box, false);
    lv_obj_move_foreground(n.box);
    if (n.timer) lv_timer_reset(n.timer);
    else n.timer = lv_timer_create(tick, 1000, NULL);
}

bool scr_notice_hit(int32_t x, int32_t y)
{
    return !lv_obj_is_hidden(n.box) && x >= BOX_X - HIT_PAD && x < BOX_X + BOX_W + HIT_PAD && y >= BOX_Y - HIT_PAD &&
           y < BOX_Y + BOX_H + HIT_PAD;
}

lv_obj_t *scr_notice_create(lv_obj_t *parent)
{
    n.box = ui_plain(parent, BOX_W, BOX_H);
    lv_obj_set_pos(n.box, BOX_X, BOX_Y);
    lv_obj_set_style_radius(n.box, 24, 0);
    lv_obj_set_style_bg_color(n.box, lv_color_hex(COLOR_BOX), 0);
    lv_obj_set_style_bg_opa(n.box, LV_OPA_COVER, 0);
    n.tile = ui_plain(n.box, TILE, TILE);
    lv_obj_set_pos(n.tile, PAD_X, 14);
    lv_obj_set_style_radius(n.tile, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(n.tile, LV_OPA_COVER, 0);
    n.dot = ui_plain(n.tile, 12, 12);
    lv_obj_set_style_radius(n.dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(n.dot, LV_OPA_COVER, 0);
    lv_obj_center(n.dot);
    int32_t tx = PAD_X + TILE + 14, tw = BOX_W - tx - PAD_X;
    n.eb = ui_label(n.box, &inter_16, UI_COLOR_SUBTLE, tw, 1, LV_TEXT_ALIGN_LEFT);
    n.title = ui_label(n.box, &inter_20, UI_COLOR_TEXT, tw, 1, LV_TEXT_ALIGN_LEFT);
    int32_t h = lv_obj_get_height(n.eb) + lv_obj_get_height(n.title), y0 = 14 + (TILE - h) / 2;
    lv_obj_set_pos(n.eb, tx, y0);
    lv_obj_set_pos(n.title, tx, y0 + lv_obj_get_height(n.eb));
    n.bar = ui_plain(n.box, BAR_W, 3);
    lv_obj_set_pos(n.bar, PAD_X, BOX_H - 8 - 3);
    lv_obj_set_style_radius(n.bar, 2, 0);
    lv_obj_set_style_bg_color(n.bar, lv_color_hex(COLOR_BAR), 0);
    lv_obj_set_style_bg_opa(n.bar, LV_OPA_COVER, 0);
    n.timer = NULL;
    lv_obj_set_hidden(n.box, true);
    return n.box;
}
