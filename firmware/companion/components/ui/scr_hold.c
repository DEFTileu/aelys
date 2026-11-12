/* Both-buttons-held overlay (design "Emergency card · both buttons"): red ring that fills clockwise
 * from 12 o'clock while the owner holds, "Keep holding" and a sleeping Aelys. */
#include "ui_screens_priv.h"

#define RING_INSET 8
#define RING_WIDTH 12

static struct { lv_obj_t *root, *ring; int pct; } h;

static void ring_draw(lv_event_t *e)
{
    lv_area_t a;
    lv_obj_get_coords(lv_event_get_target_obj(e), &a);
    lv_draw_arc_dsc_t d;
    lv_draw_arc_dsc_init(&d);
    d.width = RING_WIDTH;
    d.center.x = a.x1 + UI_SCREEN_SIZE / 2;
    d.center.y = a.y1 + UI_SCREEN_SIZE / 2;
    d.radius = UI_SCREEN_SIZE / 2 - RING_INSET;
    d.start_angle = 0;
    d.end_angle = 360;
    d.color = lv_color_hex(UI_COLOR_DANGER_BG);
    lv_draw_arc(lv_event_get_layer(e), &d);
    if (h.pct <= 0) return;
    d.color = lv_color_hex(UI_COLOR_DANGER);
    d.start_angle = 270; /* 12 o'clock; LVGL angles run clockwise from 3 o'clock */
    d.end_angle = h.pct >= 100 ? 270 + 359 : 270 + 360 * h.pct / 100;
    lv_draw_arc(lv_event_get_layer(e), &d);
}

/* Grow `box` to take in the point at `deg` on radius r around the ring centre. */
static void box_add(lv_area_t *box, const lv_area_t *ring, int deg, int32_t r)
{
    int32_t x = ring->x1 + UI_SCREEN_SIZE / 2 + (lv_trigo_cos(deg) * r >> LV_TRIGO_SHIFT);
    int32_t y = ring->y1 + UI_SCREEN_SIZE / 2 + (lv_trigo_sin(deg) * r >> LV_TRIGO_SHIFT);
    if (x < box->x1) box->x1 = x;
    if (x > box->x2) box->x2 = x;
    if (y < box->y1) box->y1 = y;
    if (y > box->y2) box->y2 = y;
}

/* Redraw only the arc between two percentages: a full-screen invalidation costs ~50 ms a frame. */
static void ring_invalidate(int from, int to)
{
    const int32_t r_out = UI_SCREEN_SIZE / 2 - RING_INSET, r_in = r_out - RING_WIDTH;
    int lo = from < to ? from : to, hi = from < to ? to : from;
    int a0 = 270 + 360 * lo / 100, a1 = 270 + 360 * hi / 100;
    lv_area_t ring, box = { INT32_MAX, INT32_MAX, INT32_MIN, INT32_MIN };
    lv_obj_get_coords(h.ring, &ring);
    box_add(&box, &ring, a0, r_out);
    box_add(&box, &ring, a0, r_in);
    box_add(&box, &ring, a1, r_out);
    box_add(&box, &ring, a1, r_in);
    for (int a = (a0 / 90 + 1) * 90; a < a1; a += 90) box_add(&box, &ring, a, r_out); /* axis extremes */
    box.x1 -= 2; box.y1 -= 2; box.x2 += 2; box.y2 += 2; /* anti-aliased edge */
    lv_obj_invalidate_area(h.ring, &box);
}

void scr_hold_set(int pct)
{
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    if (pct == h.pct) return;
    int old = h.pct;
    h.pct = pct;
    lv_obj_set_hidden(h.root, pct == 0);
    if (old > 0 && pct > 0)
        ring_invalidate(old, pct);
    else
        lv_obj_invalidate(h.ring);
}

lv_obj_t *scr_hold_create(lv_obj_t *parent)
{
    h.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    lv_obj_set_style_bg_color(h.root, lv_color_hex(UI_COLOR_BG), 0);
    lv_obj_set_style_bg_opa(h.root, LV_OPA_COVER, 0); /* covers the screen underneath */
    h.ring = ui_plain(h.root, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    lv_obj_add_event_cb(h.ring, ring_draw, LV_EVENT_DRAW_MAIN, NULL);

    lv_obj_t *face = face_create(h.root, 42); /* the design dims it to 40 %: no opacity layers here */
    face_set_mood(face, MOOD_SLEEPING);
    lv_obj_t *title = ui_label(h.root, &inter_24, UI_COLOR_TEXT, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(title, "Keep holding");
    lv_obj_t *sub = ui_label(h.root, &inter_20, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(sub, "Emergency card in 2 s");
    lv_obj_t *col[] = { face, title, sub };
    const uint8_t gap[] = { 0, 8, 8 };
    ui_stack(col, gap, 3, 0, UI_SCREEN_SIZE, -1);

    /* the design points at both buttons on the right edge: top at y 98, bottom at y 344, right edge x 394 */
    const int32_t by[2] = { 98, 344 };
    for (int i = 0; i < 2; i++) {
        lv_obj_t *l = ui_label(h.root, &inter_16, UI_COLOR_DANGER, 60, 1, LV_TEXT_ALIGN_RIGHT);
        lv_label_set_text(l, "Hold");
        lv_obj_set_pos(l, 394 - 60, by[i]);
    }
    h.pct = 0;
    lv_obj_set_hidden(h.root, true);
    return h.root;
}
