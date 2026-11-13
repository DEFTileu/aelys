/* Every mood renders as the design shows it, stays inside the round screen and only ever redraws its own area. */
#include <stdlib.h>
#include <string.h>
#include "check.h"
#include "sim_display.h"
#include "ui.h"
#include "ui_face_priv.h"

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
    gone(f);

    f = show(MOOD_SLEEPING, 100, 0, 0, 100);
    CHECK(close_to(93, 100, 0x8F, 0x70, 0xF7, 16));                /* the arc's bottom, 7 px thick */
    CHECK(dark(93, 90) && dark(93, 70) && dark(62, 72));           /* hollow, nothing above the line */
    CHECK(close_to(62, 85, 0x8F, 0x70, 0xF7, 16));                 /* its sides */
    CHECK(dark(150, 90));
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
        CHECK(g_inv_set); /* every mood has some motion */
        /* the animation only redraws the face box plus its 30 px of overhang (lids, drops, hearts) */
        CHECK(g_inv.x1 >= HX - 30 && g_inv.y1 >= HY - 30);
        CHECK(g_inv.x2 <= HX + 300 + 30 && g_inv.y2 <= HY + FACE_H + 30);
        gone(f);
    }
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

static void test_scales_and_api(void)
{
    CHECK_EQ(MOOD_COUNT, 14);
    static const int32_t S[] = { 34, 36, 42, 50, 70, 100, 107 };
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

int main(void)
{
    sim_init();
    sim_direct(); /* redraw only what was invalidated, as the board does: stale pixels would show up */
    test_shapes();
    test_inside_screen_and_own_area();
    test_rest_is_free();
    test_scales_and_api();
    return g_failed ? 1 : 0;
}
