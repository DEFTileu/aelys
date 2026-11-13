/* Every mood renders as the design shows it, stays inside the round screen and only ever redraws its own area. */
#include <stdlib.h>
#include <string.h>
#include "check.h"
#include "sim_display.h"
#include "ui.h"
#include "ui_face_priv.h"
#include "src/core/lv_obj_private.h"
#include "src/core/lv_obj_style_private.h"

typedef struct { int r, g, b; } rgb_t;

static rgb_t at(int x, int y)
{
    uint16_t c = sim_fb()[y * SIM_W + x];
    rgb_t p = { ((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31 };
    return p;
}
static int lit(int x, int y) { rgb_t p = at(x, y); return p.r + p.g + p.b > 90; }
static int dark(int x, int y) { rgb_t p = at(x, y); return p.r + p.g + p.b < 30; }
static int close_to(int x, int y, int r, int g, int b, int tol)
{
    rgb_t p = at(x, y);
    return abs(p.r - r) <= tol && abs(p.g - g) <= tol && abs(p.b - b) <= tol;
}

static lv_obj_t *show(mood_t m, int32_t scale, int x, int y, uint32_t ms)
{
    lv_obj_t *face = face_create(lv_screen_active(), scale);
    lv_obj_set_pos(face, x, y);
    face_set_mood(face, m);
    sim_step(ms);
    sim_step(20); /* the frame after the last animation step draws it */
    return face;
}

static void gone(lv_obj_t *face) { lv_obj_delete(face); sim_step(20); }

/* Each mood at its first moments (the loops have not left their rest pose yet), face box at the origin. */
static void test_shapes(void)
{
    lv_obj_t *f = show(MOOD_CALM, 100, 0, 0, 100);
    CHECK(lit(93, 85) && lit(207, 85));
    CHECK(dark(150, 85) && dark(93, 20) && dark(93, 140));
    CHECK(lit(59, 85) && dark(56, 85) && lit(127, 85));            /* 70 wide, straight sides */
    CHECK(at(93, 40).r > at(93, 128).r + 30);                      /* gradient: light at the top, deep violet below */
    CHECK(at(93, 128).b > 200);
    CHECK(close_to(106, 59, 255, 255, 255, 14));                   /* the star: white, at 38,14 of the eye */
    gone(f);

    f = show(MOOD_FOCUSED, 100, 0, 0, 100);
    CHECK(lit(93, 85) && dark(93, 55) && dark(93, 115));           /* 44 tall at 63 */
    CHECK(close_to(105, 78, 255, 255, 255, 14));                   /* 14 px star at 40,8 */
    rgb_t without_glow = at(93, 57);
    gone(f);

    f = show(MOOD_FLOW, 100, 0, 0, 100);
    rgb_t glow = at(93, 57);
    CHECK(glow.r + glow.g + glow.b > without_glow.r + without_glow.g + without_glow.b + 10);
    gone(f);

    f = show(MOOD_SLEEPING, 100, 0, 0, 100);
    CHECK(close_to(93, 100, 0x8F, 0x70, 0xF7, 16));                /* the arc's bottom, 7 px thick */
    CHECK(dark(93, 90) && dark(93, 70) && dark(62, 72));           /* hollow, nothing above the line */
    CHECK(close_to(62, 85, 0x8F, 0x70, 0xF7, 16));                 /* its sides */
    CHECK(dark(150, 90));
    gone(f);

    f = show(MOOD_EXHAUSTED, 100, 0, 0, 100);
    CHECK(at(93, 100).r < 160 && at(93, 100).g < 160 && at(93, 100).b < 170);
    gone(f);

    f = show(MOOD_OFFLINE, 100, 0, 0, 100);
    CHECK(close_to(93, 80, 0x4A, 0x45, 0x54, 12) && close_to(207, 80, 0x4A, 0x45, 0x54, 12));
    CHECK(lit(150, 123) && dark(150, 100));                        /* the middle of the three dots */
    gone(f);

    f = show(MOOD_HAPPY, 100, 0, 0, 100);
    CHECK(lit(93, 70) && dark(93, 110) && dark(93, 130));          /* only the upper arch is left */
    gone(f);

    f = show(MOOD_LOVE, 100, 0, 0, 100);
    CHECK(lit(93, 70) && dark(93, 112));
    CHECK(at(93, 136).r > 90 && at(93, 136).g < 100);              /* cheek: salmon at 45 % over black */
    gone(f);

    f = show(MOOD_PROUD, 100, 0, 0, 900);                          /* sparkle 1 is fully grown at 0.9 s */
    CHECK(close_to(27, 31, 0xE6, 0xDC, 0xFF, 24));
    gone(f);

    f = show(MOOD_SURPRISED, 100, 0, 0, 100);
    CHECK(lit(93, 34) && lit(60, 85) && lit(133, 85) && dark(48, 85)); /* 84 x 110 at 51,30 */
    gone(f);

    f = show(MOOD_CURIOUS, 100, 0, 0, 100);
    CHECK(lit(207, 29) && dark(93, 29));                           /* the right eye is taller */
    CHECK(lit(93, 128) && dark(93, 136));
    gone(f);

    f = show(MOOD_WORRIED, 100, 0, 0, 100);                        /* lid: inner ends higher, cut at 67 in the middle */
    CHECK(dark(93, 60) && lit(93, 80));
    CHECK(dark(62, 70) && lit(62, 85));
    gone(f);

    f = show(MOOD_SAD, 100, 0, 0, 100);
    CHECK(dark(93, 70) && lit(93, 90));
    gone(f);

    f = show(MOOD_ANNOYED, 100, 0, 0, 100);                        /* inner ends lower */
    CHECK(dark(93, 75) && lit(93, 90));
    CHECK(dark(120, 85) && lit(66, 78));
    gone(f);

    f = show(MOOD_SLEEPY, 100, 0, 0, 100);
    CHECK(dark(93, 70) && lit(93, 100));
    gone(f);

    f = show(MOOD_DIZZY, 100, 0, 0, 100);                          /* two violet rings with a gap on the right */
    int ring = 0;
    for (int y = 40; y < 135; y++)
        for (int x = 50; x < 250; x++)
            if (close_to(x, y, 0xA9, 0x8C, 0xFB, 14)) ring++;
    CHECK(ring > 2400 && ring < 6000);
    CHECK(dark(93, 85));                                           /* hollow */
    gone(f);
}

/* Home slot: face box at 83,148 (clock above, task line below). */
#define HX 83
#define HY 148

static lv_area_t g_inv;
static bool g_inv_set;
static void on_invalidate(lv_event_t *e)
{
    const lv_area_t *a = lv_event_get_param(e);
    if (!g_inv_set) { g_inv = *a; g_inv_set = true; return; }
    if (a->x1 < g_inv.x1) g_inv.x1 = a->x1;
    if (a->y1 < g_inv.y1) g_inv.y1 = a->y1;
    if (a->x2 > g_inv.x2) g_inv.x2 = a->x2;
    if (a->y2 > g_inv.y2) g_inv.y2 = a->y2;
}

/* Compare the partial framebuffer with a clean redraw of the entire face region.
 * Restore the partial framebuffer afterwards, so the oracle cannot repair a stale pixel. */
static uint16_t g_snap[SIM_W * SIM_H];

static int pixel_exact(void)
{
    memcpy(g_snap, sim_fb(), sizeof g_snap);
    const lv_area_t area = { HX - 40, HY - 40, HX + 300 + 40, HY + FACE_H + 40 };
    for (int y = area.y1; y <= area.y2; y++)
        memset((uint16_t *)sim_fb() + y * SIM_W + area.x1, 0xAA, (size_t)(area.x2 - area.x1 + 1) * sizeof(uint16_t));
    lv_area_t keep = g_inv; /* the reference invalidation is not the face's */
    bool kept = g_inv_set;
    lv_obj_invalidate_area(lv_screen_active(), &area);
    lv_refr_now(NULL);      /* redraw now, the animation clock does not move */
    g_inv = keep;
    g_inv_set = kept;
    int diff = 0;
    for (int i = 0; i < SIM_W * SIM_H; i++)
        if (g_snap[i] != sim_fb()[i]) {
            if (!diff) fprintf(stderr, "first difference at %d,%d: %04x vs %04x\n", i % SIM_W, i / SIM_W, g_snap[i], sim_fb()[i]);
            diff++;
        }
    memcpy((void *)sim_fb(), g_snap, sizeof g_snap);
    return diff;
}

static void test_inside_screen_and_own_area(void)
{
    lv_display_add_event_cb(lv_display_get_default(), on_invalidate, LV_EVENT_INVALIDATE_AREA, NULL);
    for (int m = 0; m < MOOD_COUNT; m++) {
        lv_obj_t *f = show((mood_t)m, 100, HX, HY, 100);
        g_inv_set = false;
        int outside = 0, lit_px = 0;
        for (uint32_t t = 0; t < 12000; t += 100) {                /* longer than every loop (the look loop is 9 s) */
            sim_step(100);
            for (int y = HY - 40; y < HY + FACE_H + 40; y++)
                for (int x = HX - 40; x < HX + 300 + 40; x++) {
                    if (!lit(x, y)) continue;
                    lit_px++;
                    int dx = x - 233, dy = y - 233;
                    if (dx * dx + dy * dy > 232 * 232) outside++;
                }
        }
        CHECK(lit_px > 500);
        CHECK_EQ(outside, 0);                                      /* nothing outside the 466 px circle */
        if (m == MOOD_BASHFUL) CHECK(!g_inv_set); /* design specifies no animation */
        else CHECK(g_inv_set);
        /* A moving face only redraws its box plus 30 px of overhang. */
        if (g_inv_set) {
            int margin = m == MOOD_ELATION ? 40 : 30;
            CHECK(g_inv.x1 >= HX - margin && g_inv.y1 >= HY - margin);
            CHECK(g_inv.x2 <= HX + 300 + margin && g_inv.y2 <= HY + FACE_H + margin);
        }
        gone(f);
    }
}

/* Run both LVGL timers at the board's 5 ms period, and compare every tick,
 * including ticks with no flush, over complete motion/effect cycles. */
static void test_partial_redraw_each_frame(void)
{
    lv_timer_t *anim = lv_anim_get_timer();
    lv_timer_t *refresh = lv_display_get_refr_timer(lv_display_get_default());
    lv_timer_set_period(anim, 5);
    lv_timer_set_period(refresh, 5);
    for (int m = 0; m < MOOD_COUNT; m++) {
        lv_obj_t *f = show((mood_t)m, 100, HX, HY, 100);
        unsigned flushed = 0;
        for (uint32_t t = 0; t < 12000; t += 5) {
            uint32_t before = sim_flushes();
            sim_step(5);
            lv_refr_now(NULL); /* also draw invalidations from the animation callback */
            if (sim_flushes() != before) flushed++;
            int diff = pixel_exact();
            if (diff) {
                fprintf(stderr, "%s at %u ms: %d pixels differ\n", mood_name((mood_t)m), t + 5, diff);
                CHECK_EQ(diff, 0);
                break;
            }
        }
        if (m == MOOD_BASHFUL) CHECK_EQ(flushed, 0); else CHECK(flushed > 0);
        gone(f);
    }
    lv_timer_set_period(anim, LV_DEF_REFR_PERIOD);
    lv_timer_set_period(refresh, LV_DEF_REFR_PERIOD);
}

/* Dirty regions must remain pixel-identical to a full redraw during a retarget. */
static void test_transition_partial_redraw(void)
{
    lv_timer_t *anim = lv_anim_get_timer();
    lv_timer_t *refresh = lv_display_get_refr_timer(lv_display_get_default());
    lv_timer_set_period(anim, 5); lv_timer_set_period(refresh, 5);
    lv_obj_t *face = show(MOOD_CALM, 100, HX, HY, 100);
    const mood_t sequence[] = {MOOD_FOCUSED, MOOD_WORRIED, MOOD_SURPRISED, MOOD_CALM};
    for (unsigned n = 0; n < sizeof sequence / sizeof *sequence; n++) {
        face_set_mood(face, sequence[n]);
        for (int t = 0; t < 1000; t += 5) {
            sim_step(5); lv_refr_now(NULL);
            int diff = pixel_exact();
            if (diff) { fprintf(stderr, "transition %u at %d ms: %d pixels differ\n", n, t, diff); CHECK_EQ(diff, 0); break; }
        }
    }
    gone(face);
    lv_timer_set_period(anim, LV_DEF_REFR_PERIOD); lv_timer_set_period(refresh, LV_DEF_REFR_PERIOD);
}

/* A face at rest costs nothing: calm does not move for the first 2.5 s of its look loop, and a hidden face never draws. */
static void test_rest_is_free(void)
{
    lv_obj_t *f = show(MOOD_CALM, 100, HX, HY, 100);
    uint32_t n = sim_flushes();
    for (int i = 0; i < 125; i++) sim_step(16);                    /* 2 s */
    CHECK_EQ(sim_flushes(), n);
    for (int i = 0; i < 250; i++) sim_step(16);                    /* the look starts at 2.5 s: now it redraws */
    CHECK(sim_flushes() > n);

    lv_obj_set_hidden(f, true);
    sim_step(100);
    n = sim_flushes();
    for (int i = 0; i < 625; i++) sim_step(16);                    /* 10 s: every loop would have moved */
    CHECK_EQ(sim_flushes(), n);
    gone(f);
}

/* A stale deadline must not freeze a face when it reappears, even across tick wrap. */
static void check_long_hidden_resume(void)
{
    lv_obj_t *f = show(MOOD_HAPPY, 100, HX, HY, 100);
    lv_obj_set_hidden(f, true);
    sim_step(20);
    sim_step(9u * 24u * 60u * 60u * 1000u);
    lv_obj_set_hidden(f, false);
    sim_step(20);
    lv_refr_now(NULL);
    memcpy(g_snap, sim_fb(), sizeof g_snap);
    bool changed = false;
    for (int i = 0; i < 20; i++) {
        sim_step(20);
        lv_refr_now(NULL);
        if (memcmp(g_snap, sim_fb(), sizeof g_snap)) changed = true;
    }
    CHECK(changed);
    gone(f);
}

static void test_long_hidden_resume(void)
{
    check_long_hidden_resume();
    /* Create the second face four days before uint32 tick wrap. */
    sim_step(UINT32_MAX - lv_tick_get() - 4u * 24u * 60u * 60u * 1000u);
    check_long_hidden_resume();
}

/* A local style gains storage when its property count grows. Inspect each face object,
 * not LVGL's draw-task allocations, during mood changes and subsequent animation. */
static unsigned local_props(const lv_obj_t *obj)
{
    unsigned n = 0;
    for (unsigned i = 0; i < obj->style_cnt; i++)
        if (obj->styles[i].is_local) n += obj->styles[i].style->prop_cnt;
    return n;
}

static void test_animation_style_footprint(void)
{
    lv_timer_t *anim = lv_anim_get_timer();
    lv_timer_t *refresh = lv_display_get_refr_timer(lv_display_get_default());
    lv_timer_set_period(anim, 5);
    lv_timer_set_period(refresh, 5);
    for (int m = 0; m < MOOD_COUNT; m++) {
        lv_obj_t *face = face_create(lv_screen_active(), 100);
        lv_obj_set_pos(face, HX, HY);
        lv_obj_update_layout(face);
        unsigned n = lv_obj_get_child_count(face);
        unsigned before[64];
        CHECK(n <= 64);
        if (n > 64) { gone(face); continue; }
        for (unsigned i = 0; i < n; i++) before[i] = local_props(lv_obj_get_child(face, i));
        face_set_mood(face, (mood_t)m);
        bool grew = false;
        for (uint32_t t = 0; t <= 12000 && !grew; t += 5) {
            if (t) sim_step(5);
            for (unsigned i = 0; i < n; i++) {
                unsigned after = local_props(lv_obj_get_child(face, i));
                if (after > before[i]) {
                    fprintf(stderr, "%s at %u ms: child %u local properties grew %u -> %u\n",
                            mood_name((mood_t)m), t, i, before[i], after);
                    grew = true;
                    break;
                }
            }
        }
        CHECK(!grew);
        gone(face);
    }
    lv_timer_set_period(anim, LV_DEF_REFR_PERIOD);
    lv_timer_set_period(refresh, LV_DEF_REFR_PERIOD);
}

static void test_scales_and_api(void)
{
    CHECK_EQ(MOOD_COUNT, 32);
    static const int32_t S[] = { 34, 36, 42, 50, 70, 100, 107, 130 };
    for (unsigned i = 0; i < sizeof S / sizeof *S; i++)
        for (int m = 0; m < MOOD_COUNT; m++) {
            lv_obj_t *face = face_create(lv_screen_active(), S[i]);
            CHECK(face != NULL);
            if (!face) continue;
            lv_obj_update_layout(face);
            CHECK_EQ(lv_obj_get_width(face), (300 * S[i] + 50) / 100);
            CHECK_EQ(lv_obj_get_height(face), (170 * S[i] + 50) / 100);
            face_set_mood(face, (mood_t)m);
            sim_step(40);
            lv_obj_delete(face);
        }
    for (int m = 0; m < MOOD_COUNT; m++) {
        const char *name = mood_name((mood_t)m);
        CHECK(name && name[0]);
        for (int k = 0; k < m; k++) CHECK(strcmp(name, mood_name((mood_t)k)) != 0);
    }
    CHECK(strcmp(mood_name(MOOD_COUNT), "?") == 0);
    CHECK(face_create(NULL, 100) == NULL);
    lv_obj_t *face = face_create(lv_screen_active(), 100);
    face_set_mood(face, MOOD_COUNT);                               /* out of range: ignored */
    face_set_mood(NULL, MOOD_CALM);
    lv_obj_delete(face);
}

static void test_elation_confetti(void)
{
    lv_obj_t *f = show(MOOD_ELATION, 100, HX, HY, 100);
    rgb_t yellow = at(HX + 74, HY - 3);
    CHECK(yellow.r > 150 && yellow.g > 120 && yellow.b < 160);
    gone(f);
}

static void test_relief_lid_moves(void)
{
    lv_obj_t *f = show(MOOD_RELIEF, 100, HX, HY, 100);
    lv_obj_t *lid = lv_obj_get_child(f, 6);
    lv_obj_update_layout(f); int initial_y = lv_obj_get_y(lid);
    sim_step(1480); lv_obj_update_layout(f);
    CHECK(lv_obj_get_y(lid) >= initial_y + 12);
    gone(f);
}

static void test_charging_lid_scales_with_eyes(void)
{
    lv_obj_t *f = show(MOOD_CHARGING, 130, HX, HY, 100);
    sim_step(2380); /* 2.5 s: breathing group at 105% */
    lv_obj_update_layout(f);
    lv_obj_t *eye = lv_obj_get_child(f, 0);
    lv_obj_t *lid = lv_obj_get_child(f, 6);
    /* A 74 px mask and its 34 px cut both follow the 105% group scale,
       then the 130% face scale. */
    CHECK(abs(lv_obj_get_width(lid) - 101) <= 1);
    int cut = lv_obj_get_y(lid) + lv_obj_get_height(lid) - 1 - lv_obj_get_y(eye);
    CHECK(abs(cut - 46) <= 1);
    sim_step(20); /* render the animation step */
    lv_obj_update_layout(f);
    lv_area_t bounds; lv_obj_get_coords(eye, &bounds);
    int cx = (bounds.x1 + bounds.x2) / 2;
    CHECK(dark(cx, bounds.y1 + 25));
    CHECK(lit(cx, bounds.y1 + 55));
    gone(f);
}

static void check_compressed_highlight(lv_obj_t *f, int side)
{
    lv_obj_t *eye = lv_obj_get_child(f, side);
    lv_obj_t *star = lv_obj_get_child(f, 2 + side);
    lv_obj_update_layout(f);
    lv_area_t a; lv_obj_get_coords(eye, &a);
    int min_y = SIM_H, max_y = -1;
    for (int y = a.y1; y <= a.y2; ++y) for (int x = a.x1; x <= a.x2; ++x) {
        rgb_t p = at(x,y);
        if (p.r > 240 && p.g > 240 && p.b > 240) {
            if (y < min_y) min_y = y;
            if (y > max_y) max_y = y;
        }
    }
    CHECK(!lv_obj_is_hidden(star));
    CHECK(max_y >= min_y);
    CHECK(max_y - min_y + 1 < lv_obj_get_width(star) * 4 / 5);
}

static void test_highlight_compresses_with_blink(void)
{
    for (int width = 5; width <= 26; ++width) {
        const lv_image_dsc_t *normal = face_img_star(width);
        CHECK(face_img_star_squashed(width, 1000) == normal);
        int last = 0;
        for (int openness = 80; openness <= 1120; openness += 40) {
            const lv_image_dsc_t *img = face_img_star_squashed(width, openness);
            CHECK_EQ(img->header.w, normal->header.w);
            CHECK(img->header.h >= last);
            CHECK(img->header.h >= 1);
            CHECK(abs((int)img->header.h * 1000 - width * openness) <= 600);
            last = img->header.h;
        }
    }
    lv_obj_t *f = show(MOOD_CALM, 100, HX, HY, 100);
    sim_step(4630); /* 4.75 s: halfway through the closing blink */
    lv_refr_now(NULL);
    check_compressed_highlight(f, 0);
    gone(f);
    f = show(MOOD_MISCHIEF, 100, HX, HY, 100);
    sim_step(1800); /* 1.92 s: right eye halfway through a wink */
    lv_refr_now(NULL);
    check_compressed_highlight(f, 1);
    gone(f);
}

static void test_asymmetric_wink_and_wake(void)
{
    lv_obj_t *f = show(MOOD_MISCHIEF, 100, HX, HY, 100);
    sim_step(2160); lv_obj_update_layout(f);
    int left = lv_obj_get_height(lv_obj_get_child(f, 0));
    int right = lv_obj_get_height(lv_obj_get_child(f, 1));
    CHECK(left >= 90); CHECK(right <= 15);
    gone(f);
    f = show(MOOD_WAKING, 100, HX, HY, 100);
    lv_obj_update_layout(f);
    CHECK(lv_obj_get_height(lv_obj_get_child(f, 0)) <= 15);
    sim_step(1530); lv_obj_update_layout(f);
    CHECK(lv_obj_get_height(lv_obj_get_child(f, 0)) >= 105);
    gone(f);
}

static void test_star_disappears_after_transition_to_no_star(void)
{
    lv_obj_t *face=show(MOOD_CALM,100,HX,HY,100);
    face_set_mood(face,MOOD_OFFLINE);
    for (int i=0;i<120;i++) sim_step(34);
    CHECK(lv_obj_is_hidden(lv_obj_get_child(face,2)));
    CHECK(lv_obj_is_hidden(lv_obj_get_child(face,3)));
    gone(face);
}

static void test_smooth_eye_transition(void)
{
    lv_obj_t *face = face_create(lv_screen_active(), 100);
    sim_step(100);
    lv_obj_t *left = lv_obj_get_child(face, 0);
    lv_obj_update_layout(face);
    int before = lv_obj_get_height(left);
    face_set_mood(face, MOOD_FOCUSED);
    lv_obj_update_layout(face);
    CHECK_EQ(lv_obj_get_height(left), before);
    sim_step(100); lv_obj_update_layout(face);
    int middle = lv_obj_get_height(left);
    CHECK(middle < before && middle > 46);
    for (int n = 0; n < 54; n++) sim_step(34);
    lv_obj_update_layout(face);
    CHECK(lv_obj_get_height(left) >= 44 && lv_obj_get_height(left) <= 47);
    lv_obj_delete(face);
}

int main(void)
{
    sim_init();
    sim_direct(); /* redraw only what was invalidated, as the board does: stale pixels would show up */
    test_elation_confetti();
    test_relief_lid_moves();
    test_charging_lid_scales_with_eyes();
    test_asymmetric_wink_and_wake();
    test_star_disappears_after_transition_to_no_star();
    test_smooth_eye_transition();
    test_shapes();
    test_inside_screen_and_own_area();
    test_partial_redraw_each_frame();
    test_transition_partial_redraw();
    test_rest_is_free();
    test_animation_style_footprint();
    test_scales_and_api();
    test_long_hidden_resume();
    test_highlight_compresses_with_blink();
    return g_failed ? 1 : 0;
}
