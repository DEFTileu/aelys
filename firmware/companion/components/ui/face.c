/* Aelys face: plain lv_obj rectangles with radius, geometry from the design's CompanionFace.dc.html.
 * Every part is created once; set_mood only restyles, repositions and shows/hides. */
#include <stdbool.h>
#include "ui.h"
#include "ui_face_priv.h"
#include "ui_theme.h"

typedef struct {
    lv_obj_t *eye[2], *lid[2], *smile[2], *cheek[2];
    lv_obj_t *glyph, *zz[2], *sweat, *sweat_tip, *spark_v, *spark_h, *dot[3];
    int32_t s;     /* scale_x100 */
    mood_t mood;
    int32_t blink; /* eye openness, permille */
} face_t;

#define BLINK_PERIOD_MS 5200

static int32_t px(const face_t *f, int32_t v) { return (v * f->s + (v < 0 ? -50 : 50)) / 100; }

static lv_obj_t *box(lv_obj_t *parent, uint32_t color)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_set_clickable(o, false);
    lv_obj_set_scrollable(o, false);
    lv_obj_set_style_bg_color(o, lv_color_hex(color), 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(o, 0, 0);
    lv_obj_set_style_pad_all(o, 0, 0);
    lv_obj_set_style_radius(o, 0, 0);
    return o;
}

static lv_obj_t *label(lv_obj_t *parent, uint32_t color, const char *txt)
{
    lv_obj_t *o = lv_label_create(parent);
    lv_obj_set_style_text_color(o, lv_color_hex(color), 0);
    lv_label_set_text_static(o, txt);
    return o;
}

static void show(lv_obj_t *o, bool on) { lv_obj_set_hidden(o, !on); }

static void eye_center(const face_mood_t *m, int side, int32_t *cx, int32_t *cy)
{
    *cx = 140 + (side ? 66 : -66) + m->eye[side].dx;
    *cy = 80 + m->eye[side].dy;
}

/* Eyes, lids and smile: everything that follows the blink. */
static void layout_eyes(face_t *f)
{
    const face_mood_t *m = face_mood_def(f->mood);
    for (int side = 0; side < 2; side++) {
        const face_eye_t *e = &m->eye[side];
        face_rect_t r = face_eye_rect(e, side, f->s, f->blink);
        int32_t shorter = r.w < r.h ? r.w : r.h;

        lv_obj_set_pos(f->eye[side], r.x, r.y);
        lv_obj_set_size(f->eye[side], r.w, r.h);
        lv_obj_set_style_radius(f->eye[side], e->r_pct * shorter / 100, 0);

        if (e->lid_pct) {
            int32_t lw = 170 * r.w / 100, lh = e->lid_pct * r.h / 100 + px(f, 2);
            lv_obj_set_pos(f->lid[side], r.x - 35 * r.w / 100, r.y - 2);
            lv_obj_set_size(f->lid[side], lw, lh);
            lv_obj_set_style_transform_pivot_x(f->lid[side], lw / 2, 0);
            lv_obj_set_style_transform_pivot_y(f->lid[side], lh, 0);
            lv_obj_set_style_transform_rotation(f->lid[side], e->tilt * (side ? -10 : 10), 0);
        }
        if (e->smile) {
            /* CSS dome: 140 % wide, top corners radius 50 % (an ellipse arch). A circle through the same
             * apex and the eye's edge is the closest thing LVGL can draw: sag = sagitta at the eye's edge. */
            int32_t sag = 93 * r.h / 1000;
            if (sag < 1) sag = 1;
            int32_t rad = (r.w * r.w / 4 + sag * sag) / (2 * sag);
            lv_obj_set_pos(f->smile[side], r.x + r.w / 2 - rad, r.y + 58 * r.h / 100);
            lv_obj_set_size(f->smile[side], 2 * rad, 2 * rad);
        }
    }
}

/* Effects only depend on the mood, not on the blink. */
static void layout_fx(face_t *f)
{
    const face_mood_t *m = face_mood_def(f->mood);
    int32_t lcx, lcy, rcx, rcy;
    eye_center(m, 0, &lcx, &lcy);
    eye_center(m, 1, &rcx, &rcy);
    bool big = f->s >= 125; /* font sets exist for scale 1.0 and 1.5 only */

    lv_obj_set_pos(f->cheek[0], px(f, lcx - 24), px(f, lcy + 50));
    lv_obj_set_pos(f->cheek[1], px(f, rcx - 16), px(f, rcy + 50));
    for (int i = 0; i < 2; i++) lv_obj_set_size(f->cheek[i], px(f, 40), px(f, 16));

    /* CSS line-height:1 centres the glyph box in a font-size tall line; LVGL top-aligns it in the font's line */
    const lv_font_t *gfont = big ? &inter_bold_fx_81 : &inter_bold_fx_54;
    const lv_font_t *z1 = big ? &inter_bold_fx_51 : &inter_bold_fx_34;
    const lv_font_t *z2 = big ? &inter_bold_fx_36 : &inter_bold_fx_24;
    int32_t gs = px(f, 54), s1 = px(f, 34), s2 = px(f, 24);
    char g[2] = { m->glyph, 0 };
    if (m->glyph) {
        lv_label_set_text(f->glyph, g);
        lv_obj_set_style_text_font(f->glyph, gfont, 0);
        lv_obj_set_pos(f->glyph, px(f, rcx + 46), px(f, rcy - 86) - (lv_font_get_line_height(gfont) - gs) / 2);
    }
    lv_obj_set_style_text_font(f->zz[0], z1, 0);
    lv_obj_set_style_text_font(f->zz[1], z2, 0);
    lv_obj_set_pos(f->zz[0], px(f, rcx + 36), px(f, rcy - 62) - (lv_font_get_line_height(z1) - s1) / 2);
    lv_obj_set_pos(f->zz[1], px(f, rcx + 66), px(f, rcy - 96) - (lv_font_get_line_height(z2) - s2) / 2);

    /* drop = circle + the sharp top-left quadrant of the 18 px box, rotated 45 degrees */
    int32_t d = px(f, 18), q = px(f, 9), dx0 = px(f, rcx + 46), dy0 = px(f, rcy - 58);
    lv_obj_set_pos(f->sweat, dx0, dy0);
    lv_obj_set_size(f->sweat, d, d);
    lv_obj_set_size(f->sweat_tip, q, q);
    lv_obj_set_pos(f->sweat_tip, dx0 + d / 2 - q / 2, dy0 + d / 2 - d * 354 / 1000 - q / 2);
    lv_obj_set_style_transform_pivot_x(f->sweat_tip, q / 2, 0);
    lv_obj_set_style_transform_pivot_y(f->sweat_tip, q / 2, 0);
    lv_obj_set_style_transform_rotation(f->sweat_tip, 450, 0);

    int32_t sp = px(f, 30), sx = px(f, rcx + 40), sy = px(f, rcy - 90);
    lv_obj_set_pos(f->spark_v, sx + 44 * sp / 100, sy);
    lv_obj_set_size(f->spark_v, 12 * sp / 100 + 1, sp);
    lv_obj_set_pos(f->spark_h, sx, sy + 44 * sp / 100);
    lv_obj_set_size(f->spark_h, sp, 12 * sp / 100 + 1);

    int32_t dd = px(f, 9), gap = px(f, 10), total = 3 * dd + 2 * gap;
    for (int i = 0; i < 3; i++) {
        lv_obj_set_size(f->dot[i], dd, dd);
        lv_obj_set_pos(f->dot[i], (px(f, 280) - total) / 2 + i * (dd + gap), px(f, lcy + 46));
    }
}

static void blink_exec(void *var, int32_t t)
{
    face_t *f = var;
    int32_t b = face_blink_x1000((uint32_t)t);
    if (b == f->blink) return; /* idle part of the cycle: nothing to redraw */
    f->blink = b;
    layout_eyes(f);
}

static void apply_mood(face_t *f)
{
    const face_mood_t *m = face_mood_def(f->mood);
    for (int side = 0; side < 2; side++) {
        const face_eye_t *e = &m->eye[side];
        lv_obj_t *eye = f->eye[side];
        lv_obj_set_style_bg_opa(eye, e->hollow ? LV_OPA_TRANSP : LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(eye, e->hollow ? px(f, 12) : 0, 0);
        show(f->lid[side], e->lid_pct != 0);
        show(f->smile[side], e->smile);
        show(f->cheek[side], m->cheeks);
    }
    show(f->glyph, m->glyph != 0);
    show(f->zz[0], m->zz);
    show(f->zz[1], m->zz);
    show(f->sweat, m->sweat);
    show(f->sweat_tip, m->sweat);
    show(f->spark_v, m->sparkle);
    show(f->spark_h, m->sparkle);
    for (int i = 0; i < 3; i++) show(f->dot[i], m->dots);
    layout_fx(f);
    layout_eyes(f);
}

/* LVGL clips invalidation to the parent plus its ext draw size: let fx outside the box be redrawn. */
static void face_ext_size(lv_event_t *e)
{
    const face_t *f = lv_event_get_user_data(e);
    lv_event_set_ext_draw_size(e, px(f, 60));
}

static void face_deleted(lv_event_t *e)
{
    face_t *f = lv_event_get_user_data(e);
    lv_anim_delete(f, blink_exec);
    lv_free(f);
}

lv_obj_t *face_create(lv_obj_t *parent, int32_t scale_x100)
{
    if (!parent || scale_x100 <= 0) return NULL;
    face_t *f = lv_malloc_zeroed(sizeof *f);
    if (!f) return NULL;
    f->s = scale_x100;
    f->blink = 1000;

    lv_obj_t *root = lv_obj_create(parent);
    lv_obj_set_clickable(root, false);
    lv_obj_set_scrollable(root, false);
    lv_obj_set_overflow_visible(root, true); /* fx stick out of the 280x160 box */
    lv_obj_set_style_bg_opa(root, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    lv_obj_set_style_pad_all(root, 0, 0);
    lv_obj_set_size(root, px(f, 280), px(f, 160));
    lv_obj_add_event_cb(root, face_ext_size, LV_EVENT_REFR_EXT_DRAW_SIZE, f);
    lv_obj_add_event_cb(root, face_deleted, LV_EVENT_DELETE, f);

    /* Lids and the smile dome are black and sit over the eye, not inside it: on the black background
     * they are invisible outside the eye, so no clip layer is needed. Order matters: each dome is
     * drawn before the other eye, which it would otherwise reach. */
    for (int i = 0; i < 2; i++) {
        f->eye[i] = box(root, UI_COLOR_EYE);
        lv_obj_set_style_border_color(f->eye[i], lv_color_hex(UI_COLOR_EYE), 0); /* ring for the hollow eye */
        f->lid[i] = box(root, UI_COLOR_BG);
        f->smile[i] = box(root, UI_COLOR_BG);
        lv_obj_set_style_radius(f->smile[i], LV_RADIUS_CIRCLE, 0);
    }
    for (int i = 0; i < 2; i++) {
        f->cheek[i] = box(root, UI_COLOR_CHEEK);
        lv_obj_set_style_bg_opa(f->cheek[i], 140, 0); /* 55 % over black */
        lv_obj_set_style_radius(f->cheek[i], LV_RADIUS_CIRCLE, 0);
    }
    f->glyph = label(root, UI_COLOR_ACCENT, "!");
    f->zz[0] = label(root, UI_COLOR_MUTED, "z");
    f->zz[1] = label(root, UI_COLOR_DIM, "z");

    f->sweat = box(root, UI_COLOR_SWEAT);
    lv_obj_set_style_radius(f->sweat, LV_RADIUS_CIRCLE, 0);
    f->sweat_tip = box(root, UI_COLOR_SWEAT);

    f->spark_v = box(root, UI_COLOR_ACCENT);
    f->spark_h = box(root, UI_COLOR_ACCENT);
    lv_obj_set_style_radius(f->spark_v, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_radius(f->spark_h, LV_RADIUS_CIRCLE, 0);

    static const uint32_t dot_color[3] = { UI_COLOR_DIM, UI_COLOR_MUTED, UI_COLOR_DIM };
    for (int i = 0; i < 3; i++) {
        f->dot[i] = box(root, dot_color[i]);
        lv_obj_set_style_radius(f->dot[i], LV_RADIUS_CIRCLE, 0);
    }

    lv_obj_set_user_data(root, f);
    face_set_mood(root, MOOD_CALM);
    return root;
}

void face_set_mood(lv_obj_t *face, mood_t m)
{
    face_t *f = face ? lv_obj_get_user_data(face) : NULL;
    if (!f || !face_mood_def(m)) return;
    f->mood = m;
    f->blink = 1000;
    lv_anim_delete(f, blink_exec);
    apply_mood(f);
    if (face_mood_def(m)->blink) {
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, f);
        lv_anim_set_exec_cb(&a, blink_exec);
        lv_anim_set_values(&a, 0, BLINK_PERIOD_MS);
        lv_anim_set_duration(&a, BLINK_PERIOD_MS);
        lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
        lv_anim_start(&a);
    }
}
