/* Aelys face, to the design's CSS (ACTUAL AELYS Companion, CompanionFace): 300x170 box at scale 1.
 *
 * Cheap primitives only, all created once in face_create(); a mood switch restyles, repositions and shows/hides.
 *  - eye: lv_obj pill with a vertical bg gradient; sleeping = a pill ring under a black cover, dizzy = lv_draw_arc,
 *    offline = flat circle.
 *  - highlight, sparkles, drops, hearts, "z": pre-rendered A8 images (img_fx.c, tools/gen_face_fx.py), recoloured
 *    and picked by pixel size, never scaled or rotated at run time.
 *  - lids (worried, sad, annoyed, sleepy, and the sleeping cover): the CSS lid is a black box rotated 16 / 18 degrees
 *    inside the eye. On the black screen only the cut along its bottom edge shows, so the lid is a black rect plus
 *    one triangle drawn by an event callback: two small fills, no transform layer, no mask image to store.
 *  - closed smiling eye (happy, proud, love): a black ellipse (a pill nearly as wide as tall) over the eye.
 *  - the CSS `.ey` group transform (look, hop, sway, ...) is applied to the eye and lid positions, not to pixels:
 *    translation and scale are exact; the +-4 / 6 / 8 / 9 degree turns (sway, tilt, wobble) move the eyes
 *    along the turn but do not tilt each pill, which would need a rotated layer per frame.
 * One lv_anim per face drives everything from integer keyframe tables (face_moods.c); a frame only touches objects
 * whose geometry changed, so LVGL invalidates just those eyes and effects, never more than the face's own area. */
#include <stdbool.h>
#include "ui.h"
#include "ui_face_priv.h"
#include "ui_theme.h"
#include "face_spring.h"

#define COLOR_GRAD_TOP 0xCDBFFF
#define COLOR_GRAD_BOTTOM 0x7C58F4
#define COLOR_SPARK 0xE6DCFF
#define COLOR_DROP 0x7FA8F5
#define COLOR_DOT_OFF 0x4A4554
#define DROOP_TRAVEL 250 /* sleepy lid: bottom edge moves 25 px (tenths) between -56 % and -30 % of 96 px */
/* The anim timer ticks every LV_DEF_REFR_PERIOD (5 ms on the board) while the panel flushes at 60 Hz (16.67 ms, TE).
 * The face uses a 33.33 ms clock in 1/3 ms; the panel and navigation remain at 60 Hz. */
#define FRAME_THIRDS 100

typedef struct { int16_t w, h, yl, yr; } cut_t; /* lid object size, cut height at its left and right edge */

typedef struct {
    lv_obj_t *root;
    lv_obj_t *eye[2], *star[2], *ring[2], *lid[2], *dome[2];
    lv_obj_t *cheek[2], *dot[3], *line[3], *spark[3], *drop, *zz[2], *heart[2];
    lv_obj_t *confetti_layer;
    face_confetti_state_t confetti_state[6];
    cut_t cut[2];
    int16_t ring_a[2];
    int16_t line_k[3], line_op[3];
    int16_t dot_mix[3];
    int32_t s;           /* scale_x100 */
    const face_mood_t *m;
    face_spring_t eye_spring[2][10];
    face_eye_t current_eye[2];
    bool eye_initialized, drawn;
    uint32_t spring_time;
    uint32_t t0, due3;   /* start of the mood's loops (ms), next frame due (1/3 ms) */
} face_t;

/* All eye dimensions are independent numerical spring targets. */
static void eye_values(const face_eye_t *e, int32_t v[10])
{
    v[0] = e->x; v[1] = e->y; v[2] = e->w; v[3] = e->h; v[4] = e->r;
    v[5] = e->star_x; v[6] = e->star_y; v[7] = e->star;
    v[8] = e->lid_y10; v[9] = e->lid_slope;
}
static void eye_step(face_t *f, uint32_t elapsed, bool snap)
{
    for (int side = 0; side < 2; ++side) {
        int32_t target[10], v[10];
        eye_values(&f->m->eye[side], target);
        for (int k = 0; k < 10; ++k) {
            if (snap) face_spring_init(&f->eye_spring[side][k], target[k]);
            else face_spring_step(&f->eye_spring[side][k], target[k], elapsed);
            v[k] = face_spring_value(&f->eye_spring[side][k]);
        }
        f->current_eye[side] = (face_eye_t){v[0], v[1], v[2], v[3], v[4],
                                           v[5], v[6], v[7], v[8], v[9]};
    }
    f->eye_initialized = true;
}

/* face px * 100 -> device px */
static int32_t d(const face_t *f, int32_t v100)
{
    int32_t x = v100 * f->s;
    return x >= 0 ? (x + 5000) / 10000 : -((-x + 5000) / 10000);
}

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
    /* Reserve geometry style slots before any mood or animation lays this out. */
    lv_obj_set_pos(o, 0, 0);
    lv_obj_set_size(o, 1, 1);
    return o;
}

static lv_obj_t *image(lv_obj_t *parent, uint32_t color)
{
    lv_obj_t *o = lv_image_create(parent);
    lv_obj_set_clickable(o, false);
    lv_obj_set_style_image_recolor(o, lv_color_hex(color), 0);
    lv_obj_set_style_image_recolor_opa(o, LV_OPA_COVER, 0);
    /* Effects first become visible during animation: do not add style slots then. */
    lv_obj_set_pos(o, 0, 0);
    lv_obj_set_style_image_opa(o, LV_OPA_COVER, 0);
    return o;
}

static void show(lv_obj_t *o, bool on)
{
    if (lv_obj_is_hidden(o) == on) lv_obj_set_hidden(o, !on);
}

static void place(lv_obj_t *o, int32_t x, int32_t y, int32_t w, int32_t h)
{
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w < 1 ? 1 : w, h < 1 ? 1 : h);
}

/* An effect image at x, y with opacity op; fully faded = hidden, so nothing is drawn. */
static void put_img(lv_obj_t *o, const lv_image_dsc_t *src, int32_t x, int32_t y, int32_t op)
{
    if (op < 3) {
        show(o, false);
        return;
    }
    if (lv_image_get_src(o) != src) lv_image_set_src(o, src);
    lv_obj_set_pos(o, x, y);
    if (lv_obj_get_style_image_opa(o, 0) != op) lv_obj_set_style_image_opa(o, (lv_opa_t)op, 0);
    show(o, true);
}

/* sin / cos of an angle in deg*100, scaled by 32768 (lv_trigo has whole degrees: interpolate) */
static void trig(int32_t rot100, int32_t *sn, int32_t *cs)
{
    if (!rot100) {
        *sn = 0;
        *cs = 32768;
        return;
    }
    int32_t deg = rot100 / 100, fr = rot100 % 100, next = deg + (fr < 0 ? -1 : 1);
    if (fr < 0) fr = -fr;
    *sn = lv_trigo_sin((int16_t)deg) + (lv_trigo_sin((int16_t)next) - lv_trigo_sin((int16_t)deg)) * fr / 100;
    *cs = lv_trigo_cos((int16_t)deg) + (lv_trigo_cos((int16_t)next) - lv_trigo_cos((int16_t)deg)) * fr / 100;
}

/* The group transform (scale, turn about the box centre, then translate) of a point, face px * 100. */
static void group_pt(const face_group_t *g, int32_t sn, int32_t cs, int32_t *x, int32_t *y)
{
    int32_t dx = *x - FACE_W * 50, dy = *y - FACE_H * 50;
    int32_t rx = (dx * cs - dy * sn) >> 15, ry = (dx * sn + dy * cs) >> 15;
    *x = FACE_W * 50 + rx * g->sc / 1000 + g->tx;
    *y = FACE_H * 50 + ry * g->sc / 1000 + g->ty;
}

/* Confetti geometry and colors from the celebration state; the layer draws
 * all pieces and invalidates only their old/new bounds during animation. */
typedef struct { int16_t x, y; uint16_t delay_ms; uint32_t color; } confetti_spec_t;
static const confetti_spec_t CONFETTI[6] = {
    {20,0,0,0xB9A8FF}, {70,-10,400,0xF4C46B}, {232,-6,200,0x5FD7A8},
    {270,4,800,0xF6907F}, {150,-14,1100,0x7FA8F5}, {110,0,600,0xE6DCFF},
};
static void confetti_center(const face_t *f, int i, face_confetti_state_t state, int32_t *x, int32_t *y)
{
    lv_area_t root;
    lv_obj_get_coords(f->root, &root);
    *x = root.x1 + d(f, (CONFETTI[i].x + 4) * 100);
    *y = root.y1 + d(f, (CONFETTI[i].y + 7) * 100 + state.dy100);
}
static void confetti_invalidate(face_t *f, int i, face_confetti_state_t state)
{
    if (!state.opacity) return;
    int32_t x, y, radius = d(f, 1200) + 2;
    confetti_center(f, i, state, &x, &y);
    lv_area_t area = {x - radius, y - radius, x + radius, y + radius};
    lv_obj_invalidate_area(f->confetti_layer, &area);
}
static void confetti_draw(lv_event_t *e)
{
    const face_t *f = lv_event_get_user_data(e);
    for (int i = 0; i < 6; i++) {
        face_confetti_state_t state = f->confetti_state[i];
        if (!state.opacity) continue;
        int32_t x, y; confetti_center(f, i, state, &x, &y);
        int32_t half = d(f, 700);
        int32_t dx = lv_trigo_sin(state.angle) * half / 32768;
        int32_t dy = lv_trigo_cos(state.angle) * half / 32768;
        lv_draw_line_dsc_t line; lv_draw_line_dsc_init(&line);
        line.color = lv_color_hex(CONFETTI[i].color); line.opa = state.opacity;
        line.width = d(f, 800); if (line.width < 1) line.width = 1;
        line.round_start = line.round_end = 1;
        line.p1.x = x - dx; line.p1.y = y - dy;
        line.p2.x = x + dx; line.p2.y = y + dy;
        lv_draw_line(lv_event_get_layer(e), &line);
    }
}

/* ---- drawing callbacks ---- */

static void lid_draw(lv_event_t *e)
{
    const face_t *f = lv_event_get_user_data(e);
    lv_obj_t *o = lv_event_get_target_obj(e);
    const cut_t *c = &f->cut[o == f->lid[1]];
    lv_layer_t *layer = lv_event_get_layer(e);
    lv_area_t a;
    lv_obj_get_coords(o, &a);
    if (f->m->lid == LID_RELAX) {
        lv_draw_rect_dsc_t lid;
        lv_draw_rect_dsc_init(&lid);
        lid.bg_color = lv_color_hex(UI_COLOR_BG); lid.bg_opa = LV_OPA_COVER;
        lid.radius = (a.y2 - a.y1 + 1) / 2;
        lv_draw_rect(layer, &lid, &a);
        return;
    }

    int32_t lo = c->yl < c->yr ? c->yl : c->yr;
    lv_draw_rect_dsc_t r;
    lv_draw_rect_dsc_init(&r);
    r.bg_color = lv_color_hex(UI_COLOR_BG);
    r.bg_opa = LV_OPA_COVER;
    lv_area_t ra = { a.x1, a.y1, a.x2, a.y1 + lo - 1 };
    if (lo > 0) lv_draw_rect(layer, &r, &ra);
    if (c->yl == c->yr) return;

    /* the wedge between the flat part and the slanted cut; its third corner sits just above the rect so the
     * two overlap instead of leaving a seam */
    lv_draw_triangle_dsc_t t;
    lv_draw_triangle_dsc_init(&t);
    t.color = lv_color_hex(UI_COLOR_BG);
    if (c->yl < c->yr) {
        t.p[0].x = a.x1; t.p[0].y = a.y1 + c->yl;
        t.p[1].x = a.x2; t.p[1].y = a.y1 + c->yr;
        t.p[2].x = a.x2; t.p[2].y = a.y1 + c->yl - 2;
    } else {
        t.p[0].x = a.x2; t.p[0].y = a.y1 + c->yr;
        t.p[1].x = a.x1; t.p[1].y = a.y1 + c->yl;
        t.p[2].x = a.x1; t.p[2].y = a.y1 + c->yr - 2;
    }
    lv_draw_triangle(layer, &t);
}

/* Dizzy eye: a ring of the box's size with the right 90 degrees open, turning once a second. */
static void ring_draw(lv_event_t *e)
{
    const face_t *f = lv_event_get_user_data(e);
    lv_obj_t *o = lv_event_get_target_obj(e);
    int side = o == f->ring[1];
    lv_area_t a;
    lv_obj_get_coords(o, &a);
    lv_draw_arc_dsc_t arc;
    lv_draw_arc_dsc_init(&arc);
    arc.color = lv_color_hex(f->m->color);
    arc.width = (f->m->border * f->s + 50) / 100;
    arc.center.x = (a.x1 + a.x2 + 1) / 2;
    arc.center.y = (a.y1 + a.y2 + 1) / 2;
    arc.radius = (uint16_t)((a.x2 - a.x1 + 1) / 2);
    arc.start_angle = (45 + f->ring_a[side]) % 360;
    arc.end_angle = (315 + f->ring_a[side]) % 360;
    lv_draw_arc(lv_event_get_layer(e), &arc);
}

/* Surprised burst line: 5 px wide, round ends, the CSS box (22 px long) squashed to k permille. */
static void line_draw(lv_event_t *e)
{
    const face_t *f = lv_event_get_user_data(e);
    lv_obj_t *o = lv_event_get_target_obj(e);
    int i = o == f->line[1] ? 1 : o == f->line[2] ? 2 : 0;
    lv_area_t a;
    lv_obj_get_coords(o, &a);
    int32_t cx = (a.x1 + a.x2 + 1) / 2, cy = (a.y1 + a.y2 + 1) / 2;
    int32_t half = (1100 * f->line_k[i] / 1000 - 250) * f->s / 10000; /* between the end caps' centres */
    int32_t deg = f->m->line[i].size;
    int32_t ux = -lv_trigo_sin((int16_t)deg) * half / 32768, uy = lv_trigo_cos((int16_t)deg) * half / 32768;
    lv_draw_line_dsc_t l;
    lv_draw_line_dsc_init(&l);
    /* a faded line is drawn at full opacity in a darker colour (black behind it): partial opacity would double-blend
     * where the cap circles overlap the body */
    l.color = lv_color_mix(lv_color_hex(COLOR_SPARK), lv_color_black(), (uint8_t)f->line_op[i]);
    l.width = (5 * f->s + 50) / 100 < 1 ? 1 : (5 * f->s + 50) / 100;
    l.round_start = l.round_end = 1;
    l.p1.x = cx - ux; l.p1.y = cy - uy;
    l.p2.x = cx + ux; l.p2.y = cy + uy;
    lv_draw_line(lv_event_get_layer(e), &l);
}

/* ---- layout ---- */

static void lid_set(face_t *f, int side, int32_t x1, int32_t top, int32_t x2, int32_t yl, int32_t yr)
{
    int32_t bottom = (yl > yr ? yl : yr) + 1;
    cut_t c = { (int16_t)(x2 - x1 + 1), (int16_t)bottom, (int16_t)yl, (int16_t)yr };
    lv_obj_t *o = f->lid[side];
    place(o, x1, top, c.w, bottom);
    if (c.yl != f->cut[side].yl || c.yr != f->cut[side].yr || c.h != f->cut[side].h || c.w != f->cut[side].w) {
        f->cut[side] = c;
        lv_obj_invalidate(o);
    }
    show(o, true);
}

/* Eyes, lids, highlights: everything that follows the group transform and the blink. */
static void layout_eyes(face_t *f, uint32_t t)
{
    const face_mood_t *m = f->m;
    face_group_t g = face_group_at((face_motion_t)m->motion, t);
    int32_t sn, cs;
    trig(g.rot, &sn, &cs);

    for (int side = 0; side < 2; side++) {
        const face_eye_t *e = &f->current_eye[side];
        int32_t blink = face_eye_openness(m, side, t);
        /* CSS blink: scaleY about 50 % 60 % of the eye */
        int32_t w100 = e->w * 100, h100 = e->h * blink / 10;
        int32_t top100 = e->y * 100 + e->h * 60 * (1000 - blink) / 1000;
        int32_t cx = e->x * 100 + w100 / 2, cy = top100 + h100 / 2;
        group_pt(&g, sn, cs, &cx, &cy);
        w100 = w100 * g.sc / 1000;
        h100 = h100 * g.sc / 1000;
        int32_t x1 = d(f, cx - w100 / 2), y1 = d(f, cy - h100 / 2);
        int32_t x2 = d(f, cx + w100 / 2), y2 = d(f, cy + h100 / 2);

        if (m->kind == EYE_RING) {
            place(f->ring[side], x1, y1, x2 - x1, y2 - y1);
            int16_t a = (int16_t)(t % 1000 * 360 / 1000); /* one turn a second, the right eye the other way */
            if (side) a = (int16_t)((360 - a) % 360);
            if (a != f->ring_a[side]) {
                f->ring_a[side] = a;
                lv_obj_invalidate(f->ring[side]);
            }
            continue;
        }
        if (m->kind == EYE_ARC) {
            /* U-shaped line: a ring twice as tall as the visible 28 px, its top half under a black cover */
            int32_t vh = y2 - y1, bw = d(f, m->border * 100 * g.sc / 1000);
            place(f->eye[side], x1, y1 - vh, x2 - x1, 2 * vh);
            if (lv_obj_get_style_border_width(f->eye[side], 0) != (bw < 1 ? 1 : bw)) /* a style set always invalidates */
                lv_obj_set_style_border_width(f->eye[side], bw < 1 ? 1 : bw, 0);
            lid_set(f, side, x1 - 2, y1 - vh - 2, x2 + 2, vh + 2, vh + 2);
            continue;
        }
        place(f->eye[side], x1, y1, x2 - x1, y2 - y1);

        if (e->star) {
            int32_t sx = cx - w100 / 2 + e->star_x * g.sc / 10, sy = cy - h100 / 2 + e->star_y * blink * g.sc / 10000;
            const lv_image_dsc_t *img = face_img_star(d(f, e->star * g.sc / 10));
            /* squashed by a blink the star would have to flatten with the eye: hide it for those few frames */
            put_img(f->star[side], img, d(f, sx), d(f, sy), blink >= 700 ? (m->star_opacity ? m->star_opacity : 255) : 0);
        }

        if (m->lid == LID_RELAX) {
            int32_t px = e->x * 100 + e->w * 50;
            int32_t py = e->y * 100 - 4600 + 3900 + face_relax_lid_y100(t);
            group_pt(&g, sn, cs, &px, &py);
            int32_t hw = (e->w + 20) * 50 * g.sc / 1000, hh = 3900 * g.sc / 1000;
            int32_t left = d(f, px - hw), top = d(f, py - hh);
            place(f->lid[side], left, top, d(f, px + hw) - left, d(f, py + hh) - top);
            show(f->lid[side], true);
        } else if (m->lid == LID_SLANT || m->lid == LID_DROOP) {
            int32_t cut10 = e->lid_y10;
            if (m->lid == LID_DROOP) cut10 += DROOP_TRAVEL * g.ty / 600; /* same timing as the sink */
            int32_t ax = e->x * 100 + e->w * 50, ay = e->y * 100 + cut10 * 10;
            group_pt(&g, sn, cs, &ax, &ay);
            int32_t xl = ax - e->w * 50 - 200, xr = ax + e->w * 50 + 200; /* the eye plus 2 px */
            int32_t yl = ay + e->lid_slope * (xl - ax) / 1000, yr = ay + e->lid_slope * (xr - ax) / 1000;
            int32_t top = d(f, ay - cut10 * 10 - 600);
            lid_set(f, side, d(f, xl), top, d(f, xr), d(f, yl) - top, d(f, yr) - top);
        } else if (m->lid == LID_DOME) {
            /* left -14, right -14, top 52, 96 tall: an ellipse 98 x 96 */
            int32_t px = e->x * 100 + e->w * 50, py = e->y * 100 + 10000;
            group_pt(&g, sn, cs, &px, &py);
            int32_t dw = (e->w + 28) * 50;
            place(f->dome[side], d(f, px - dw), d(f, py - 4800), d(f, px + dw) - d(f, px - dw), d(f, py + 4800) - d(f, py - 4800));
            show(f->dome[side], true);
        }
    }
}

/* Effects: sparkles, drops, "z", hearts, burst lines and the offline dots. They do not follow the eye group. */
static void layout_fx(face_t *f, uint32_t t)
{
    const face_mood_t *m = f->m;
    if (m->confetti) {
        for (int i = 0; i < 6; i++) {
            face_confetti_state_t next = face_confetti_at(t, CONFETTI[i].delay_ms);
            face_confetti_state_t old = f->confetti_state[i];
            if (old.dy100 != next.dy100 || old.angle != next.angle || old.opacity != next.opacity) {
                confetti_invalidate(f, i, old);
                f->confetti_state[i] = next;
                confetti_invalidate(f, i, next);
            }
        }
    }
    for (int i = 0; i < m->n_spark; i++) {
        const face_fx_t *p = &m->spark[i];
        face_fx_state_t st = face_fx_twinkle(t, p->delay_ms);
        const lv_image_dsc_t *img = face_img_star(d(f, p->size * st.k / 10));
        int32_t cx = d(f, p->x * 100 + p->size * 50), cy = d(f, p->y * 100 + p->size * 50);
        put_img(f->spark[i], img, cx - img->header.w / 2, cy - img->header.h / 2, st.op);
    }
    if (m->drop) {
        /* the CSS box is turned 45 degrees about its centre: the pre-rendered drop is 0.7071 * edge above it */
        face_fx_state_t st = face_fx_drip(t, m->drop_ms);
        const lv_image_dsc_t *img = face_img_drop(d(f, m->drop_at.size * 100));
        int32_t cx = d(f, m->drop_at.x * 100 + m->drop_at.size * 50 + st.dx);
        int32_t cy = d(f, m->drop_at.y * 100 + m->drop_at.size * 50 + st.dy);
        put_img(f->drop, img, cx - img->header.w / 2, cy - img->header.w * 7071 / 10000, st.op);
    }
    for (int i = 0; i < m->n_zz; i++) {
        /* line-height 1: the lower-case z sits from .32 to .86 of the font size (x-height .55) */
        const face_fx_t *p = &m->zz[i];
        face_fx_state_t st = face_fx_rise(t, 3200, p->delay_ms);
        const lv_image_dsc_t *img = face_img_z((p->size * 55 * f->s + 5000) / 10000);
        put_img(f->zz[i], img, d(f, p->x * 100 + p->size * 3 + st.dx), d(f, p->y * 100 + p->size * 32 + st.dy), st.op);
    }
    for (int i = 0; i < m->n_heart; i++) {
        const face_fx_t *p = &m->heart[i];
        face_fx_state_t st = face_fx_rise(t, 2800, p->delay_ms);
        put_img(f->heart[i], face_img_heart(d(f, p->size * 100)), d(f, p->x * 100 + st.dx), d(f, p->y * 100 + st.dy), st.op);
    }
    if (m->n_line) {
        face_fx_state_t st = face_fx_burst(t);
        for (int i = 0; i < m->n_line; i++) {
            int16_t k = (int16_t)(st.k / 25 * 25), op = (int16_t)(st.op == 255 ? 255 : st.op / 8 * 8); /* steps, not every value */
            if (op != f->line_op[i] || k != f->line_k[i]) {
                f->line_op[i] = op;
                f->line_k[i] = k;
                lv_obj_invalidate(f->line[i]);
            }
            show(f->line[i], op > 0);
        }
    }
    if (m->dots)
        for (int i = 0; i < 3; i++) {
            int32_t mix = face_fx_dot(t, i) / 4 * 4;
            if (mix == f->dot_mix[i]) continue;
            f->dot_mix[i] = (int16_t)mix;
            lv_obj_set_style_bg_color(f->dot[i], lv_color_mix(lv_color_hex(UI_COLOR_ACCENT), lv_color_hex(COLOR_DOT_OFF), (uint8_t)mix), 0);
        }
}

static void tick(void *var, int32_t unused)
{
    face_t *f = var;
    (void)unused;
    uint32_t now = lv_tick_get();
    uint32_t now3 = now * 3;
    /* Keep hidden faces' deadlines current, so a long absence cannot make the
     * signed modular comparison ambiguous when they become visible again. */
    if (!lv_obj_is_visible(f->root)) { f->due3 = now3; f->spring_time = now; return; }
    if ((int32_t)(now3 - f->due3) < 0) return;
    f->due3 += FRAME_THIRDS;
    if ((int32_t)(now3 - f->due3) >= 0) f->due3 = now3 + FRAME_THIRDS; /* far behind (hidden, stalled): do not catch up */
    eye_step(f, now - f->spring_time, false);
    f->spring_time = now;
    f->drawn = true;
    layout_eyes(f, now - f->t0);
    layout_fx(f, now - f->t0);
}

/* A new mood: restyle and show / hide; the first frame is laid out right away. */
static void apply_mood(face_t *f)
{
    const face_mood_t *m = f->m;
    bool ring = m->kind == EYE_RING, arc = m->kind == EYE_ARC;
    for (int side = 0; side < 2; side++) {
        lv_obj_t *eye = f->eye[side];
        show(eye, !ring);
        lv_obj_set_style_border_width(eye, 0, 0);
        lv_obj_set_style_shadow_width(eye, d(f, m->glow_width * 100), 0);
        if (m->kind == EYE_PILL) {
            lv_obj_set_style_bg_opa(eye, LV_OPA_COVER, 0);
            lv_obj_set_style_bg_color(eye, lv_color_hex(m->gradient_top ? m->gradient_top : COLOR_GRAD_TOP), 0);
            lv_obj_set_style_bg_grad_color(eye, lv_color_hex(m->gradient_bottom ? m->gradient_bottom : COLOR_GRAD_BOTTOM), 0);
            lv_obj_set_style_bg_grad_dir(eye, LV_GRAD_DIR_VER, 0);
        } else {
            lv_obj_set_style_bg_grad_dir(eye, LV_GRAD_DIR_NONE, 0);
            lv_obj_set_style_bg_opa(eye, arc ? LV_OPA_TRANSP : LV_OPA_COVER, 0);
            lv_obj_set_style_bg_color(eye, lv_color_hex(m->color), 0);
            lv_obj_set_style_border_color(eye, lv_color_hex(m->color), 0);
        }
        show(f->ring[side], ring);
        show(f->lid[side], false); /* laid out (and shown) by the frame when this mood has one */
        show(f->dome[side], false);
        show(f->star[side], false);
        show(f->cheek[side], m->cheeks);
    }
    show(f->drop, false);
    show(f->confetti_layer, m->confetti);
    for (int i = 0; i < 6; i++) f->confetti_state[i] = (face_confetti_state_t){0};
    for (int i = 0; i < 3; i++) {
        show(f->spark[i], false);
        show(f->line[i], false);
        show(f->dot[i], m->dots);
        f->line_k[i] = f->line_op[i] = -1;
        f->dot_mix[i] = -1;
    }
    for (int i = 0; i < 2; i++) {
        show(f->zz[i], false);
        show(f->heart[i], false);
    }
    for (int i = 0; i < m->n_line; i++) {
        int32_t n = d(f, 2800), cx = d(f, m->line[i].x * 100 + 250), cy = d(f, m->line[i].y * 100 + 1100);
        place(f->line[i], cx - n / 2, cy - n / 2, n, n);
    }
    /* cheeks: 44 x 16 at 71 / 185, 128 */
    for (int i = 0; i < 2; i++) place(f->cheek[i], d(f, (i ? 185 : 71) * 100), d(f, 12800), d(f, 4400), d(f, 1600));
    /* three 10 px dots 12 px apart, centred, at 118 */
    for (int i = 0; i < 3; i++) place(f->dot[i], d(f, (123 + 22 * i) * 100), d(f, 11800), d(f, 1000), d(f, 1000));
}

/* Confetti can start 34 px above the face; allow 40 px of overhang. */
static void face_ext_size(lv_event_t *e)
{
    const face_t *f = lv_event_get_user_data(e);
    lv_event_set_ext_draw_size(e, d(f, 4000));
}

static void face_deleted(lv_event_t *e)
{
    face_t *f = lv_event_get_user_data(e);
    lv_anim_delete(f, tick);
    lv_free(f);
}

lv_obj_t *face_create(lv_obj_t *parent, int32_t scale_x100)
{
    if (!parent || scale_x100 <= 0) return NULL;
    face_t *f = lv_malloc_zeroed(sizeof *f);
    if (!f) return NULL;
    f->s = scale_x100;

    lv_obj_t *root = lv_obj_create(parent);
    f->root = root;
    lv_obj_set_clickable(root, false);
    lv_obj_set_scrollable(root, false);
    lv_obj_set_overflow_visible(root, true);
    lv_obj_set_style_bg_opa(root, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    lv_obj_set_style_pad_all(root, 0, 0);
    lv_obj_set_size(root, d(f, FACE_W * 100), d(f, FACE_H * 100));
    lv_obj_add_event_cb(root, face_ext_size, LV_EVENT_REFR_EXT_DRAW_SIZE, f);
    lv_obj_add_event_cb(root, face_deleted, LV_EVENT_DELETE, f);

    /* stacking: eyes, highlights, lids over them, then the effects (a drop or heart may sit under a lid's reach) */
    for (int i = 0; i < 2; i++) {
        f->eye[i] = box(root, 0);
        lv_obj_set_style_radius(f->eye[i], LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_border_color(f->eye[i], lv_color_black(), 0);
        /* Reserve glow style properties at creation, before mood changes. */
        lv_obj_set_style_shadow_width(f->eye[i], 0, 0);
        lv_obj_set_style_shadow_color(f->eye[i], lv_color_hex(0xB9A8FF), 0);
        lv_obj_set_style_shadow_opa(f->eye[i], 140, 0);
    }
    for (int i = 0; i < 2; i++) f->star[i] = image(root, 0xFFFFFF);
    for (int i = 0; i < 2; i++) {
        f->ring[i] = box(root, 0);
        lv_obj_set_style_bg_opa(f->ring[i], LV_OPA_TRANSP, 0);
        lv_obj_add_event_cb(f->ring[i], ring_draw, LV_EVENT_DRAW_MAIN, f);
        lv_obj_set_user_flag(f->ring[i], 1, true);
    }
    for (int i = 0; i < 2; i++) {
        f->lid[i] = box(root, UI_COLOR_BG);
        lv_obj_set_style_bg_opa(f->lid[i], LV_OPA_TRANSP, 0);
        lv_obj_add_event_cb(f->lid[i], lid_draw, LV_EVENT_DRAW_MAIN, f);
        lv_obj_set_user_flag(f->lid[i], 1, true);
    }
    for (int i = 0; i < 2; i++) {
        f->dome[i] = box(root, UI_COLOR_BG);
        lv_obj_set_style_radius(f->dome[i], LV_RADIUS_CIRCLE, 0);
    }
    for (int i = 0; i < 2; i++) {
        f->cheek[i] = box(root, UI_COLOR_CHEEK);
        lv_obj_set_style_bg_opa(f->cheek[i], 115, 0); /* rgba(246,144,127,.45) */
        lv_obj_set_style_radius(f->cheek[i], LV_RADIUS_CIRCLE, 0);
    }
    for (int i = 0; i < 3; i++) {
        f->dot[i] = box(root, COLOR_DOT_OFF);
        lv_obj_set_style_radius(f->dot[i], LV_RADIUS_CIRCLE, 0);
    }
    for (int i = 0; i < 3; i++) {
        f->line[i] = box(root, 0);
        lv_obj_set_style_bg_opa(f->line[i], LV_OPA_TRANSP, 0);
        lv_obj_add_event_cb(f->line[i], line_draw, LV_EVENT_DRAW_MAIN, f);
        lv_obj_set_user_flag(f->line[i], 1, true);
        f->spark[i] = image(root, COLOR_SPARK);
    }
    f->drop = image(root, COLOR_DROP);
    for (int i = 0; i < 2; i++) {
        f->zz[i] = image(root, UI_COLOR_MUTED);
        f->heart[i] = image(root, UI_COLOR_CHEEK);
    }

    f->confetti_layer = box(root, UI_COLOR_BG);
    lv_obj_set_style_bg_opa(f->confetti_layer, LV_OPA_TRANSP, 0);
    lv_obj_set_size(f->confetti_layer, d(f, FACE_W * 100), d(f, (FACE_H + 80) * 100));
    lv_obj_set_pos(f->confetti_layer, 0, -d(f, 4000));
    lv_obj_add_event_cb(f->confetti_layer, confetti_draw, LV_EVENT_DRAW_MAIN, f);
    lv_obj_set_user_flag(f->confetti_layer, 1, true);
    lv_obj_set_hidden(f->confetti_layer, true);

    lv_obj_set_user_data(root, f);
    face_set_mood(root, MOOD_CALM);

    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, f);
    lv_anim_set_exec_cb(&a, tick);
    lv_anim_set_values(&a, 0, 1000);
    lv_anim_set_duration(&a, 1000);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_start(&a);
    return root;
}

void face_set_mood(lv_obj_t *face, mood_t m)
{
    face_t *f = face ? lv_obj_get_user_data(face) : NULL;
    if (!f || !face_mood_def(m)) return;
    f->m = face_mood_def(m);
    f->t0 = lv_tick_get();
    f->due3 = f->t0 * 3;
    f->spring_time = f->t0;
    if (!f->eye_initialized || !f->drawn) eye_step(f, 0, true);
    apply_mood(f);
    layout_eyes(f, 0);
    layout_fx(f, 0);
}
