/* The face's data and pure helpers against the design (ACTUAL AELYS Companion CSS), scale 1 = 300x170. */
#include <stdlib.h>
#include "check.h"
#include "ui_face_priv.h"

static const face_eye_t *eye(mood_t m, int side) { return &face_mood_def(m)->eye[side]; }

#define EYE_IS(m, side, X, Y, W, H, R) do { const face_eye_t *e_ = eye(m, side); \
    CHECK_EQ(e_->x, X); CHECK_EQ(e_->y, Y); CHECK_EQ(e_->w, W); CHECK_EQ(e_->h, H); CHECK_EQ(e_->r, R); } while (0)
#define STAR_IS(m, side, X, Y, S) do { const face_eye_t *e_ = eye(m, side); \
    CHECK_EQ(e_->star_x, X); CHECK_EQ(e_->star_y, Y); CHECK_EQ(e_->star, S); } while (0)
#define NEAR(a, b, tol) CHECK(labs((long)(a) - (long)(b)) <= (tol))

static void test_character_motion_design(void)
{
    const struct { mood_t mood; uint32_t period; uint32_t time; int tx, ty, rot, scale; } cases[] = {
        {MOOD_ELATION,1200,300,0,-1400,-600,1000}, {MOOD_PANIC,220,55,-400,100,0,1000},
        {MOOD_ANTICIPATION,2600,1430,1400,-1000,0,1000}, {MOOD_THINKING,3400,0,-600,-800,0,1000},
        {MOOD_FRIGHTENED,1800,144,0,-2200,0,1100}, {MOOD_TICKLED,200,100,0,-300,0,1000},
        {MOOD_BORED,7000,1750,600,-400,0,1000}, {MOOD_MISSED,4400,880,-2400,0,0,1000},
        {MOOD_MISCHIEF,3000,0,0,0,-700,1000},
    };
    for (unsigned i = 0; i < sizeof cases / sizeof *cases; i++) {
        face_motion_t motion = (face_motion_t)face_mood_def(cases[i].mood)->motion;
        CHECK_EQ(face_motion_period(motion), cases[i].period);
        face_group_t g = face_group_at(motion, cases[i].time);
        NEAR(g.tx, cases[i].tx, 10); NEAR(g.ty, cases[i].ty, 10);
        NEAR(g.rot, cases[i].rot, 10); NEAR(g.sc, cases[i].scale, 2);
    }
    CHECK(face_mood_def(MOOD_ELATION)->confetti);
    face_confetti_state_t cf = face_confetti_at(0, 400);
    CHECK_EQ(cf.opacity, 255); CHECK_EQ(cf.dy100, 0);
    cf = face_confetti_at(400, 400); CHECK_EQ(cf.opacity, 0); CHECK_EQ(cf.dy100, -2000);
    cf = face_confetti_at(670, 400); CHECK_EQ(cf.opacity, 255); CHECK_EQ(cf.dy100, 100); CHECK_EQ(cf.angle, 45);
    cf = face_confetti_at(2200, 400); CHECK_EQ(cf.opacity, 0); CHECK_EQ(cf.dy100, -2000);
    CHECK_EQ(face_mood_def(MOOD_FLOW)->glow_width, 22);
    CHECK_EQ(face_mood_def(MOOD_RELIEF)->lid, LID_RELAX);
    CHECK_EQ(face_relax_lid_y100(0), 0);
    CHECK_EQ(face_relax_lid_y100(1600), 800);
    CHECK_EQ(face_relax_lid_y100(3200), 0);
    const face_mood_t *a = face_mood_def(MOOD_ATTENTION);
    CHECK_EQ(face_eye_openness(a,0,2100),1000); CHECK_EQ(face_eye_openness(a,0,2190),80);
    CHECK_EQ(face_eye_openness(a,0,2340),1000); CHECK_EQ(face_eye_openness(a,0,2430),80);
    const face_mood_t *wink = face_mood_def(MOOD_MISCHIEF);
    CHECK_EQ(face_eye_openness(wink,0,2280),1000); CHECK_EQ(face_eye_openness(wink,1,2280),100);
    const face_mood_t *wake = face_mood_def(MOOD_WAKING);
    CHECK_EQ(face_eye_openness(wake,0,0),100); CHECK_EQ(face_eye_openness(wake,0,1650),1120);
    CHECK_EQ(face_eye_openness(wake,1,2100),1000);
}

static void test_all_character_rows(void)
{
    CHECK_EQ(CHAR_MOOD_COUNT, 32);
    for (int m = 0; m < CHAR_MOOD_COUNT; m++) {
        mood_t mapped = mood_from_character((character_mood_t)m);
        CHECK(mapped >= 0 && mapped < MOOD_COUNT);
        for (int k = 0; k < m; k++) CHECK(mapped != mood_from_character((character_mood_t)k));
    }
    CHECK_EQ(mood_from_character(CHAR_MOOD_COUNT), MOOD_CALM);
    CHECK_EQ(MOOD_COUNT, 32);
    for (int m = 0; m < MOOD_COUNT; m++) {
        const face_mood_t *row = face_mood_def((mood_t)m);
        CHECK(row != NULL);
        CHECK(mood_name((mood_t)m)[0] != '?');
        for (int side = 0; side < 2; side++) {
            CHECK(row->eye[side].w > 0 && row->eye[side].h > 0);
            CHECK(row->eye[side].x >= 0 && row->eye[side].x + row->eye[side].w <= FACE_W);
        }
    }
}
static void test_eyes(void)
{
    for (int s = 0; s < 2; s++) {
        int x = s ? 172 : 58;
        EYE_IS(MOOD_CALM, s, x, 35, 70, 100, 35);
        STAR_IS(MOOD_CALM, s, 38, 14, 20);
        EYE_IS(MOOD_HAPPY, s, x, 35, 70, 100, 35);
        EYE_IS(MOOD_PROUD, s, x, 35, 70, 100, 35);
        EYE_IS(MOOD_LOVE, s, x, 35, 70, 100, 35);
        EYE_IS(MOOD_FOCUSED, s, x, 63, 70, 44, 22);
        STAR_IS(MOOD_FOCUSED, s, 40, 8, 14);
        EYE_IS(MOOD_WORRIED, s, x, 42, 70, 92, 35);
        EYE_IS(MOOD_SAD, s, x, 56, 70, 80, 35);
        EYE_IS(MOOD_SURPRISED, s, x - 7, 30, 84, 110, 42); /* margin-left -7 */
        STAR_IS(MOOD_SURPRISED, s, 46, 14, 20);
        EYE_IS(MOOD_SLEEPY, s, x, 42, 70, 96, 35);
        EYE_IS(MOOD_SLEEPING, s, x, 76, 70, 28, 35);
        EYE_IS(MOOD_DIZZY, s, x - 3, 47, 76, 76, 38);      /* margin-left -3 */
        EYE_IS(MOOD_ANNOYED, s, x, 54, 70, 76, 35);
        EYE_IS(MOOD_OFFLINE, s, x + 21, 66, 28, 28, 14);   /* margin-left 21 */
    }
    EYE_IS(MOOD_CURIOUS, 0, 58, 46, 70, 84, 35);
    EYE_IS(MOOD_CURIOUS, 1, 172, 26, 70, 112, 35);
    STAR_IS(MOOD_CURIOUS, 1, 38, 14, 20);
    for (int m = 0; m <= MOOD_OFFLINE; m++) {
        int none = m == MOOD_SLEEPING || m == MOOD_DIZZY || m == MOOD_OFFLINE;
        CHECK_EQ(eye(m, 0)->star == 0, none);
        CHECK_EQ(eye(m, 1)->star == 0, none);
    }

    const face_mood_t *sl = face_mood_def(MOOD_SLEEPING), *dz = face_mood_def(MOOD_DIZZY), *of = face_mood_def(MOOD_OFFLINE);
    CHECK_EQ(sl->kind, EYE_ARC); CHECK_EQ(sl->border, 7); CHECK_EQ(sl->color, 0x8F70F7);
    CHECK_EQ(dz->kind, EYE_RING); CHECK_EQ(dz->border, 12); CHECK_EQ(dz->color, 0xA98CFB);
    CHECK_EQ(of->kind, EYE_DOT); CHECK_EQ(of->color, 0x4A4554);
    CHECK_EQ(face_mood_def(MOOD_CALM)->kind, EYE_PILL);
    CHECK(face_mood_def(MOOD_COUNT) == NULL);
}

static void test_lids(void)
{
    static const struct { mood_t m; face_lid_t lid; } L[] = {
        { MOOD_CALM, LID_NONE }, { MOOD_HAPPY, LID_DOME }, { MOOD_PROUD, LID_DOME }, { MOOD_FOCUSED, LID_NONE },
        { MOOD_WORRIED, LID_SLANT }, { MOOD_SAD, LID_SLANT }, { MOOD_SURPRISED, LID_NONE }, { MOOD_CURIOUS, LID_NONE },
        { MOOD_SLEEPY, LID_DROOP }, { MOOD_SLEEPING, LID_NONE }, { MOOD_DIZZY, LID_NONE }, { MOOD_ANNOYED, LID_SLANT },
        { MOOD_LOVE, LID_DOME }, { MOOD_OFFLINE, LID_NONE },
    };
    for (unsigned i = 0; i < sizeof L / sizeof *L; i++) CHECK_EQ(face_mood_def(L[i].m)->lid, L[i].lid);
    /* the cut line of the rotated black lid at the eye's middle: worried 25.3 px, sad 23.1, annoyed 27.3;
     * slope tan(16 deg) = .287, tan(18 deg) = .325, inner corners higher for worried and sad, lower for annoyed */
    NEAR(eye(MOOD_WORRIED, 0)->lid_y10, 253, 3); NEAR(eye(MOOD_WORRIED, 0)->lid_slope, -287, 3);
    NEAR(eye(MOOD_WORRIED, 1)->lid_y10, 253, 3); NEAR(eye(MOOD_WORRIED, 1)->lid_slope, 287, 3);
    NEAR(eye(MOOD_SAD, 0)->lid_y10, 231, 3);     NEAR(eye(MOOD_SAD, 0)->lid_slope, -287, 3);
    NEAR(eye(MOOD_SAD, 1)->lid_slope, 287, 3);
    NEAR(eye(MOOD_ANNOYED, 0)->lid_y10, 273, 3); NEAR(eye(MOOD_ANNOYED, 0)->lid_slope, 325, 3);
    NEAR(eye(MOOD_ANNOYED, 1)->lid_slope, -325, 3);
}

static void test_motion_and_blink(void)
{
    static const struct { mood_t m; face_motion_t mot; uint16_t blink; } M[] = {
        { MOOD_CALM, MOT_LOOK, 5000 }, { MOOD_HAPPY, MOT_HOP, 0 }, { MOOD_PROUD, MOT_HOP_SLOW, 0 },
        { MOOD_FOCUSED, MOT_BREATHE, 8000 }, { MOOD_WORRIED, MOT_JIT, 5000 }, { MOOD_SAD, MOT_SINK, 6000 },
        { MOOD_SURPRISED, MOT_POP, 5000 }, { MOOD_CURIOUS, MOT_TILT, 5000 }, { MOOD_SLEEPY, MOT_SINK_SLOW, 0 },
        { MOOD_SLEEPING, MOT_BREATHE, 0 }, { MOOD_DIZZY, MOT_WOBBLE, 0 }, { MOOD_ANNOYED, MOT_HUFF, 6000 },
        { MOOD_LOVE, MOT_SWAY, 0 }, { MOOD_OFFLINE, MOT_NONE, 0 },
    };
    for (unsigned i = 0; i < sizeof M / sizeof *M; i++) {
        CHECK_EQ(face_mood_def(M[i].m)->motion, M[i].mot);
        CHECK_EQ(face_mood_def(M[i].m)->blink_ms, M[i].blink);
    }

    CHECK_EQ(face_motion_period(MOT_LOOK), 9000);
    CHECK_EQ(face_motion_period(MOT_HOP), 1000);
    CHECK_EQ(face_motion_period(MOT_HOP_SLOW), 1600);
    CHECK_EQ(face_motion_period(MOT_NONE), 0);
    face_group_t g = face_group_at(MOT_LOOK, 0);
    CHECK_EQ(g.tx, 0); CHECK_EQ(g.ty, 0); CHECK_EQ(g.rot, 0); CHECK_EQ(g.sc, 1000);
    g = face_group_at(MOT_LOOK, 3600);  CHECK_EQ(g.tx, -1400); CHECK_EQ(g.ty, 200);   /* 40 %: looking left */
    g = face_group_at(MOT_LOOK, 5760);  CHECK_EQ(g.tx, 1200);  CHECK_EQ(g.ty, -400);  /* 64 %: right and up */
    g = face_group_at(MOT_LOOK, 8100);  CHECK_EQ(g.tx, 0);
    g = face_group_at(MOT_LOOK, 2790);  NEAR(g.tx, -700, 5);                          /* middle of the move: eased half way */
    g = face_group_at(MOT_LOOK, 9000 + 3600); CHECK_EQ(g.tx, -1400);                 /* loops */
    g = face_group_at(MOT_HOP, 500);      CHECK_EQ(g.ty, -1000);
    g = face_group_at(MOT_HOP_SLOW, 800); CHECK_EQ(g.ty, -1000);
    g = face_group_at(MOT_SWAY, 0);       CHECK_EQ(g.rot, -400);
    g = face_group_at(MOT_SWAY, 1500);    CHECK_EQ(g.rot, 400);
    g = face_group_at(MOT_BREATHE, 2000); CHECK_EQ(g.sc, 1050);
    g = face_group_at(MOT_BREATHE, 0);    CHECK_EQ(g.sc, 1000);
    g = face_group_at(MOT_JIT, 350);      CHECK_EQ(g.tx, -300);
    g = face_group_at(MOT_JIT, 1050);     CHECK_EQ(g.tx, 300);
    g = face_group_at(MOT_SINK, 2000);    CHECK_EQ(g.ty, 600);
    g = face_group_at(MOT_SINK_SLOW, 2250); CHECK_EQ(g.ty, 600);
    g = face_group_at(MOT_POP, 960);      CHECK_EQ(g.sc, 1160);
    g = face_group_at(MOT_POP, 1440);     CHECK_EQ(g.sc, 1080);
    g = face_group_at(MOT_POP, 0);        CHECK_EQ(g.sc, 1000);
    g = face_group_at(MOT_TILT, 1200);    CHECK_EQ(g.rot, -800); CHECK_EQ(g.tx, -1400); CHECK_EQ(g.ty, 0);
    g = face_group_at(MOT_TILT, 2800);    CHECK_EQ(g.rot, 600);  CHECK_EQ(g.tx, 1400);  CHECK_EQ(g.ty, -400);
    g = face_group_at(MOT_WOBBLE, 0);     CHECK_EQ(g.rot, -900);
    g = face_group_at(MOT_WOBBLE, 800);   CHECK_EQ(g.rot, 900);
    g = face_group_at(MOT_HUFF, 1350);    CHECK_EQ(g.tx, 1600);
    g = face_group_at(MOT_HUFF, 2040);    CHECK_EQ(g.tx, 1800);
    g = face_group_at(MOT_NONE, 1234);    CHECK_EQ(g.tx, 0); CHECK_EQ(g.rot, 0); CHECK_EQ(g.sc, 1000);

    /* blink: open until 93 %, shut to 8 % at 96 %, open again at 100 % */
    CHECK_EQ(face_blink_x1000(5000, 0), 1000);
    CHECK_EQ(face_blink_x1000(5000, 4600), 1000);
    CHECK_EQ(face_blink_x1000(5000, 4800), 80);
    CHECK_EQ(face_blink_x1000(5000, 5000), 1000);
    NEAR(face_blink_x1000(5000, 4725), 540, 60);
    CHECK_EQ(face_blink_x1000(8000, 7680), 80);
    CHECK_EQ(face_blink_x1000(0, 123), 1000);
}

static void test_fx(void)
{
    const face_mood_t *p = face_mood_def(MOOD_PROUD);
    CHECK_EQ(p->n_spark, 3);
    CHECK_EQ(p->spark[0].x, 14);  CHECK_EQ(p->spark[0].y, 18);  CHECK_EQ(p->spark[0].size, 26);
    CHECK_EQ(p->spark[1].x, 262); CHECK_EQ(p->spark[1].y, 4);   CHECK_EQ(p->spark[1].delay_ms, 600);
    CHECK_EQ(p->spark[2].x, 268); CHECK_EQ(p->spark[2].y, 118); CHECK_EQ(p->spark[2].size, 20); CHECK_EQ(p->spark[2].delay_ms, 1200);
    const face_mood_t *w = face_mood_def(MOOD_WORRIED), *s = face_mood_def(MOOD_SAD);
    CHECK(w->drop); CHECK_EQ(w->drop_at.x, 256); CHECK_EQ(w->drop_at.y, 26); CHECK_EQ(w->drop_ms, 2400);
    CHECK(s->drop); CHECK_EQ(s->drop_at.x, 84); CHECK_EQ(s->drop_at.y, 132); CHECK_EQ(s->drop_ms, 3200);
    const face_mood_t *su = face_mood_def(MOOD_SURPRISED);
    CHECK_EQ(su->n_line, 3);
    CHECK_EQ(su->line[0].x, 252); CHECK_EQ(su->line[0].y, 12); CHECK_EQ(su->line[0].size, 40);
    CHECK_EQ(su->line[1].x, 270); CHECK_EQ(su->line[1].y, 42); CHECK_EQ(su->line[1].size, 70);
    CHECK_EQ(su->line[2].x, 230); CHECK_EQ(su->line[2].y, 0);  CHECK_EQ(su->line[2].size, 12);
    const face_mood_t *sl = face_mood_def(MOOD_SLEEPING);
    CHECK_EQ(sl->n_zz, 2);
    CHECK_EQ(sl->zz[0].x, 238); CHECK_EQ(sl->zz[0].y, 56); CHECK_EQ(sl->zz[0].size, 30);
    CHECK_EQ(sl->zz[1].x, 264); CHECK_EQ(sl->zz[1].y, 28); CHECK_EQ(sl->zz[1].size, 22); CHECK_EQ(sl->zz[1].delay_ms, 1600);
    const face_mood_t *lv = face_mood_def(MOOD_LOVE);
    CHECK(lv->cheeks); CHECK_EQ(lv->n_heart, 2);
    CHECK_EQ(lv->heart[0].x, 258); CHECK_EQ(lv->heart[0].y, 20);
    CHECK_EQ(lv->heart[1].x, 16);  CHECK_EQ(lv->heart[1].y, 34); CHECK_EQ(lv->heart[1].delay_ms, 1400);
    CHECK(face_mood_def(MOOD_OFFLINE)->dots);
    const face_mood_t *c = face_mood_def(MOOD_CALM);
    CHECK(!c->drop && !c->cheeks && !c->dots && !c->n_spark && !c->n_zz && !c->n_heart && !c->n_line);

    face_fx_state_t f = face_fx_rise(0, 3200, 0);        /* z: fades in by 30 %, drifts up and right, fades out */
    CHECK_EQ(f.op, 0); CHECK_EQ(f.dx, 0); CHECK_EQ(f.dy, 1000);
    f = face_fx_rise(960, 3200, 0);                      CHECK_EQ(f.op, 255);
    f = face_fx_rise(1600, 3200, 0);                     NEAR(f.dx, 800, 5); NEAR(f.dy, -1200, 5);
    f = face_fx_rise(3199, 3200, 0);                     CHECK(f.op < 6); NEAR(f.dx, 1600, 20); NEAR(f.dy, -3400, 20);
    f = face_fx_rise(1600, 3200, 1600);                  CHECK_EQ(f.op, 0); /* delayed by half a loop: starts over */
    f = face_fx_drip(0, 2400);                           CHECK_EQ(f.op, 0); CHECK_EQ(f.dy, -400);
    f = face_fx_drip(600, 2400);                         CHECK_EQ(f.op, 255);
    f = face_fx_drip(1200, 2400);                        NEAR(f.dy, 550, 10);  /* ease-in */
    f = face_fx_twinkle(0, 0);                           CHECK_EQ(f.op, 0); CHECK_EQ(f.k, 200);
    f = face_fx_twinkle(900, 0);                         CHECK_EQ(f.op, 255); CHECK_EQ(f.k, 1000);
    f = face_fx_twinkle(900 + 600, 600);                 CHECK_EQ(f.op, 255);
    f = face_fx_burst(0);                                CHECK_EQ(f.op, 0);
    f = face_fx_burst(720);                              CHECK_EQ(f.op, 0); CHECK_EQ(f.k, 300);
    f = face_fx_burst(1008);                             CHECK_EQ(f.op, 255); CHECK_EQ(f.k, 1000);
    f = face_fx_burst(2000);                             CHECK_EQ(f.op, 0);
    CHECK_EQ(face_fx_dot(0, 0), 0);
    CHECK_EQ(face_fx_dot(450, 0), 255);
    CHECK_EQ(face_fx_dot(900, 0), 0);
    CHECK_EQ(face_fx_dot(700, 1), 255);
    CHECK_EQ(face_fx_dot(950, 2), 255);
}

static void test_images(void)
{
    const lv_image_dsc_t *s = face_img_star(20);
    CHECK_EQ(s->header.w, 20); CHECK_EQ(s->header.h, 20); CHECK_EQ(s->header.cf, LV_COLOR_FORMAT_A8);
    CHECK_EQ(s->header.stride, 20); CHECK_EQ(s->data_size, 400);
    CHECK(s->data[10 * 20 + 10] >= 250);                      /* middle opaque */
    CHECK_EQ(s->data[0], 0); CHECK_EQ(s->data[19], 0);        /* corners clear: a 4-point star */
    CHECK(s->data[0 * 20 + 9] > 0 || s->data[1 * 20 + 9] > 0); /* the upper tip */
    CHECK_EQ(face_img_star(14)->header.w, 14);
    CHECK_EQ(face_img_star(1)->header.w, 5);                  /* clamped to the ladder */
    CHECK_EQ(face_img_star(99)->header.w, 26);
    const lv_image_dsc_t *h = face_img_heart(24);
    CHECK_EQ(h->header.w, 24); CHECK_EQ(h->header.h, 22);
    CHECK(h->data[8 * 24 + 12] >= 250);
    const lv_image_dsc_t *d = face_img_drop(16);
    CHECK_EQ(d->header.w, 16); CHECK_EQ(d->header.h, 20);
    CHECK(d->data[1 * 16 + 8] > 0);                           /* the tip is at the top middle */
    CHECK_EQ(d->data[1 * 16 + 0], 0);
    const lv_image_dsc_t *z = face_img_z(16);
    CHECK_EQ(z->header.h, 16); CHECK_EQ(z->header.w, 15);
    CHECK(z->data[0] > 200 && z->data[14] > 200);             /* top bar across */
}

int main(void)
{
    test_character_motion_design();
    test_all_character_rows();
    test_eyes();
    test_lids();
    test_motion_and_blink();
    test_fx();
    test_images();
    return g_failed ? 1 : 0;
}
