/* Toast: one rounded line low on the display ("No connection", "Didn't work - try again"), on top of every screen for 2 s.
 * No design frame; colours from the tokens (a RULE-grey pill with TEXT letters).
 * Wi-Fi card (designs "Wi-Fi с телефона" and "Wi-Fi · неверный пароль"): a rounded card in the middle of the display for a network
 * the owner sent from the phone: connecting (until the answer), connected (2 s), wrong password (5 s, to be read). No icons: the
 * firmware has no icon font.
 * Find overlay (design "Найти Элис"): while the board beeps, a full-screen element of its own on top of everything: the ring flashes
 * (250 ms lit / 250 ms dim), three ripples spread from the middle, a surprised Aelys, "Here I am!" and "Playing sound · tap to stop".
 * Not a screen (screens.c keeps the one below). Deviations: no volume icon (no icon font), the ripples and the flash step every 125 ms
 * (one timer, border opacity instead of opacity layers). */
#include <stdio.h>
#include <string.h>
#include "ui_screens_priv.h"

#define TOAST_MS 2000
#define TOAST_W 250
#define TOAST_H 36
#define TOAST_Y 372 /* its bottom corners are at radius ~210: inside the circle */

#define CARD_W 300
#define CARD_PAD 16
#define CARD_BG 0x1C1A24 /* design: the card behind "New Wi-Fi from phone" */
#define CARD_BLUE 0x7FA8F5
#define CARD_GREEN 0x5FD7A8
#define CARD_CONNECTING_MS 20000 /* a safety net: an attempt is over after 15 s, and its answer replaces the card */
#define CARD_CONNECTED_MS 2000
#define CARD_FAILED_MS 5000

static struct { lv_obj_t *box, *label; lv_timer_t *timer; } h;
static struct { lv_obj_t *box, *eyebrow, *name, *sub, *fix; lv_timer_t *timer; } w;

#define FIND_TICK_MS 125
#define FIND_RING_DIM 0x1B1926 /* UI_COLOR_ACCENT at 15 %: the design's flash */
#define FIND_RIPPLES 3
#define FIND_RIPPLE_D 300      /* design: 300 px, scale .4 -> 1.3 over the first 40 % of 1.8 s, three of them 0.6 s apart */
#define FIND_RIPPLE_MS 1800
#define FIND_RIPPLE_LIFE_MS 720
static struct { lv_obj_t *root, *ring, *rip[FIND_RIPPLES]; lv_timer_t *timer; uint32_t t0, ms; bool lit; } f;

static void toast_hide(lv_timer_t *t)
{
    (void)t;
    h.timer = NULL; /* one-shot */
    lv_obj_set_hidden(h.box, true);
}

static void card_hide(lv_timer_t *t)
{
    (void)t;
    w.timer = NULL; /* one-shot */
    lv_obj_set_hidden(w.box, true);
}

void scr_toast_hide(void)
{
    if (h.timer) { lv_timer_delete(h.timer); h.timer = NULL; }
    lv_obj_set_hidden(h.box, true);
    if (w.timer) { lv_timer_delete(w.timer); w.timer = NULL; }
    lv_obj_set_hidden(w.box, true);
}

void scr_wifi_card_hide(void)
{
    if (w.timer) { lv_timer_delete(w.timer); w.timer = NULL; }
    lv_obj_set_hidden(w.box, true);
}

bool scr_wifi_card_show(uint8_t state, const char *ssid, const char *prev)
{
    if (state > 2) return false;
    char still[40];
    snprintf(still, sizeof still, "still on %s", prev);
    ui_set_text(w.eyebrow, state == 0 ? "New Wi-Fi from phone" : state == 1 ? "Connected" : "Wrong password");
    ui_text_color(w.eyebrow, state == 0 ? CARD_BLUE : state == 1 ? CARD_GREEN : UI_COLOR_DANGER);
    ui_set_text(w.name, ssid);
    lv_obj_set_hidden(w.sub, state == 1 || (state == 2 && !prev[0]));
    ui_set_text(w.sub, state == 0 ? "Connecting\xE2\x80\xA6" : still);
    lv_obj_set_hidden(w.fix, state != 2);

    lv_obj_t *col[] = { w.eyebrow, w.name, w.sub, w.fix };
    const uint8_t gap[] = { 0, 2, 2, 6 };
    int32_t total = 0;
    bool first = true;
    for (int i = 0; i < 4; i++)
        if (!lv_obj_is_hidden(col[i])) { total += lv_obj_get_height(col[i]) + (first ? 0 : gap[i]); first = false; }
    int32_t bh = total + 2 * CARD_PAD;
    lv_obj_set_size(w.box, CARD_W, bh);
    lv_obj_set_pos(w.box, (UI_SCREEN_SIZE - CARD_W) / 2, (UI_SCREEN_SIZE - bh) / 2);
    ui_stack(col, gap, 4, 0, bh, -1);
    lv_obj_set_hidden(w.box, false);
    lv_obj_move_foreground(w.box);
    uint32_t ms = state == 0 ? CARD_CONNECTING_MS : state == 1 ? CARD_CONNECTED_MS : CARD_FAILED_MS;
    if (w.timer) {
        lv_timer_set_period(w.timer, ms);
        lv_timer_reset(w.timer);
    } else {
        w.timer = lv_timer_create(card_hide, ms, NULL);
        lv_timer_set_repeat_count(w.timer, 1);
    }
    return true;
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

    w.box = ui_plain(parent, CARD_W, 100);
    lv_obj_set_style_radius(w.box, 24, 0);
    lv_obj_set_style_bg_color(w.box, lv_color_hex(CARD_BG), 0);
    lv_obj_set_style_bg_opa(w.box, LV_OPA_COVER, 0);
    int32_t iw = CARD_W - 2 * CARD_PAD;
    w.eyebrow = ui_label(w.box, &inter_16, CARD_BLUE, iw, 1, LV_TEXT_ALIGN_CENTER);
    w.name = ui_label(w.box, &inter_20, UI_COLOR_TEXT, iw, 1, LV_TEXT_ALIGN_CENTER);
    w.sub = ui_label(w.box, &inter_16, UI_COLOR_SUBTLE, iw, 1, LV_TEXT_ALIGN_CENTER);
    w.fix = ui_label(w.box, &inter_16, UI_COLOR_MUTED, iw, 1, LV_TEXT_ALIGN_CENTER);
    ui_set_text(w.fix, "Fix it in Aelys on your phone");
    lv_obj_set_hidden(w.box, true);
    w.timer = NULL;
    return h.box;
}

static void find_draw(void)
{
    bool lit = f.ms % 500 < 250;
    if (lit != f.lit) {
        f.lit = lit;
        lv_obj_set_style_border_color(f.ring, lv_color_hex(lit ? UI_COLOR_ACCENT : FIND_RING_DIM), 0);
    }
    for (int i = 0; i < FIND_RIPPLES; i++) {
        int32_t t = (int32_t)f.ms - i * 600; /* ripple i starts i x 0.6 s in */
        if (t < 0) t = FIND_RIPPLE_MS; /* not started: hidden */
        t %= FIND_RIPPLE_MS;
        bool on = t < FIND_RIPPLE_LIFE_MS;
        lv_obj_set_hidden(f.rip[i], !on);
        if (!on) continue;
        int32_t d = FIND_RIPPLE_D * 4 / 10 + FIND_RIPPLE_D * 9 / 10 * t / FIND_RIPPLE_LIFE_MS;
        lv_obj_set_size(f.rip[i], d, d);
        lv_obj_set_pos(f.rip[i], (UI_SCREEN_SIZE - d) / 2, (UI_SCREEN_SIZE - d) / 2);
        lv_obj_set_style_border_opa(f.rip[i], (lv_opa_t)(230 - 230 * t / FIND_RIPPLE_LIFE_MS), 0);
    }
}

static void find_tick(lv_timer_t *t)
{
    (void)t;
    f.ms = lv_tick_elaps(f.t0); /* wall time, not a tick count: a late frame must not slow the flash */
    find_draw();
}

void scr_find_show(bool on)
{
    if (on == !lv_obj_is_hidden(f.root)) return;
    if (!on) {
        if (f.timer) { lv_timer_delete(f.timer); f.timer = NULL; }
        lv_obj_set_hidden(f.root, true);
        return;
    }
    f.t0 = lv_tick_get();
    f.ms = 0;
    f.lit = false; /* find_draw() lights it */
    find_draw();
    lv_obj_set_hidden(f.root, false);
    lv_obj_move_foreground(f.root);
    f.timer = lv_timer_create(find_tick, FIND_TICK_MS, NULL);
}

lv_obj_t *scr_find_create(lv_obj_t *parent)
{
    f.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    lv_obj_set_style_bg_color(f.root, lv_color_hex(UI_COLOR_BG), 0);
    lv_obj_set_style_bg_opa(f.root, LV_OPA_COVER, 0); /* covers whatever screen is up */
    f.ring = ui_ring(f.root, 8, 12, UI_COLOR_ACCENT);
    for (int i = 0; i < FIND_RIPPLES; i++) {
        f.rip[i] = ui_plain(f.root, FIND_RIPPLE_D, FIND_RIPPLE_D);
        lv_obj_set_style_radius(f.rip[i], LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_border_width(f.rip[i], 3, 0);
        lv_obj_set_style_border_color(f.rip[i], lv_color_hex(UI_COLOR_ACCENT), 0);
    }
    lv_obj_t *face = face_create(f.root, 70);
    face_set_mood(face, MOOD_SURPRISED);
    lv_obj_t *title = ui_label(f.root, &inter_28, UI_COLOR_TEXT, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(title, "Here I am!");
    lv_obj_t *sub = ui_label(f.root, &inter_16, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(sub, "Playing sound \xC2\xB7 tap to stop");
    lv_obj_t *col[] = { face, title, sub };
    const uint8_t gap[] = { 0, 8, 8 };
    ui_stack(col, gap, 3, 0, UI_SCREEN_SIZE, -1);
    f.timer = NULL;
    lv_obj_set_hidden(f.root, true);
    return f.root;
}
