#include <stdint.h>
#include <string.h>
#include "face_raster.h"
#include "check.h"

static void test_capsule_gradient_and_clipping(void)
{
    uint32_t storage[14 * 14];
    for (unsigned i=0; i<14*14; ++i) storage[i] = 0x11223344u;
    face_raster_surface_t surface = { .pixels = storage + 15, .width = 12, .height = 12, .stride = 14, .capacity = 181 };
    for (unsigned y=0; y<12; ++y) for (unsigned x=0; x<12; ++x) surface.pixels[y*14+x] = 0;
    face_raster_eye_t eye = { .x = 2, .y = 2, .width = 8, .height = 8, .radius = 4,
        .top_rgb = 0xe0d0ff, .bottom_rgb = 0x6040d0 };
    CHECK(face_raster_eye(&surface, &eye));
    CHECK_EQ(storage[0], 0x11223344u); /* outside the supplied surface */
    CHECK_EQ(storage[13], 0x11223344u);
    CHECK_EQ(surface.pixels[2*14+2] >> 24, 0); /* rounded corner */
    CHECK_EQ(surface.pixels[5*14+5] >> 24, 255);
    uint32_t upper = surface.pixels[3*14+5], lower = surface.pixels[8*14+5];
    CHECK(((upper >> 16) & 255) > ((lower >> 16) & 255));
    CHECK_EQ(surface.pixels[0], 0); /* untouched outside the eye rectangle */
}

static void test_slanted_lid_and_star(void)
{
    uint32_t pixels[12*12] = {0};
    const uint8_t star[4] = {0, 128, 255, 0};
    face_raster_surface_t s = {.pixels=pixels,.width=12,.height=12,.stride=12,.capacity=144};
    face_raster_eye_t e = {.x=1,.y=1,.width=10,.height=10,.radius=2,
        .top_rgb=0x8040c0,.bottom_rgb=0x8040c0,.lid=FACE_RASTER_LID_SLANT,
        .lid_y10=40,.lid_slope=0,.star_x=4,.star_y=5,.star_w=2,.star_h=2,.star_data=star,.star_stride=2,.star_size=4,.star_opacity=255};
    CHECK(face_raster_eye(&s,&e));
    CHECK_EQ(pixels[2*12+6], 0xff000000u);
    CHECK_EQ(pixels[8*12+6] >> 24, 255);
    CHECK_EQ(pixels[7*12+5] & 0x00ffffffu, 0x00ffffffu);
    CHECK((pixels[6*12+6] & 0x00ffffffu) != 0x008040c0u);
}

static void test_reject_invalid_and_handle_partial_offscreen(void)
{
    uint32_t pixels[8*8]; memset(pixels, 0, sizeof pixels);
    face_raster_surface_t s = {.pixels=pixels,.width=8,.height=8,.stride=8,.capacity=64};
    face_raster_eye_t e = {.x=-4,.y=-3,.width=8,.height=8,.radius=0,.top_rgb=0x123456,.bottom_rgb=0x123456};
    CHECK(face_raster_eye(&s,&e)); CHECK_EQ(pixels[0], 0xff123456u);
    CHECK_EQ(pixels[4*8+3], 0xff123456u); CHECK_EQ(pixels[5*8+4], 0);
    uint32_t before[64]; memcpy(before,pixels,sizeof before);
    s.stride=7; CHECK(!face_raster_eye(&s,&e));
    CHECK(!memcmp(before,pixels,sizeof before));
    s.stride=8; s.capacity=63; CHECK(!face_raster_eye(&s,&e));
    CHECK(!memcmp(before,pixels,sizeof before));
    s.capacity=64; e.width=0; CHECK(!face_raster_eye(&s,&e));
    CHECK(!memcmp(before,pixels,sizeof before));
    e.width=8; e.star_data=(const uint8_t *)before; e.star_w=2; e.star_h=2; e.star_stride=2; e.star_size=3;
    CHECK(!face_raster_eye(&s,&e)); CHECK(!memcmp(before,pixels,sizeof before));
    e.star_data=NULL; e.star_w=e.star_h=0; e.x=INT32_MIN; e.y=INT32_MAX;
    CHECK(face_raster_eye(&s,&e)); CHECK(!memcmp(before,pixels,sizeof before));
    CHECK(!face_raster_eye(NULL,&e));
}

static void test_star_overhang_and_opaque_lid(void)
{
    uint32_t pixels[12*12] = {0}; const uint8_t star[] = {255,255,255,255};
    face_raster_surface_t s = {.pixels=pixels,.width=12,.height=12,.stride=12,.capacity=144};
    face_raster_eye_t e = {.x=4,.y=3,.width=4,.height=6,.radius=0,.top_rgb=0x8040c0,.bottom_rgb=0x8040c0,
        .star_x=-2,.star_y=3,.star_w=2,.star_h=2,.star_stride=2,.star_size=4,.star_data=star,.star_opacity=255};
    CHECK(face_raster_eye(&s,&e));
    CHECK_EQ(pixels[6*12+2], 0xffffffffu); /* highlight can extend beyond eye */
    memset(pixels,0,sizeof pixels);
    e.lid=FACE_RASTER_LID_SLANT; e.lid_y10=30; e.lid_slope=0;
    CHECK(face_raster_eye(&s,&e));
    CHECK_EQ(pixels[4*12+3], 0xff000000u); /* opaque mask can extend beyond eye */
}

static void test_dome_and_rotating_ring(void)
{
    uint32_t pixels[16*16] = {0};
    face_raster_surface_t s = {.pixels=pixels,.width=16,.height=16,.stride=16,.capacity=256};
    face_raster_eye_t e = {.x=2,.y=2,.width=12,.height=12,.radius=0,
        .top_rgb=0x8040c0,.bottom_rgb=0x8040c0,.lid=FACE_RASTER_LID_DOME,
        .dome_cx=8,.dome_cy=14,.dome_rx=8,.dome_ry=7};
    CHECK(face_raster_eye(&s,&e));
    CHECK_EQ(pixels[4*16+8] >> 24, 255);
    CHECK_EQ(pixels[11*16+8], 0xff000000u);
    memset(pixels,0,sizeof pixels);
    e.lid=FACE_RASTER_LID_NONE; e.kind=FACE_RASTER_RING; e.border=2; e.ring_cos=32768; e.ring_sin=0;
    CHECK(face_raster_eye(&s,&e));
    CHECK_EQ(pixels[8*16+3] >> 24, 255); /* left side */
    CHECK_EQ(pixels[8*16+13] >> 24, 0); /* gap at right */
    CHECK_EQ(pixels[8*16+8] >> 24, 0); /* hollow */
    memset(pixels,0,sizeof pixels);
    e.ring_cos=0; e.ring_sin=32768;
    CHECK(face_raster_eye(&s,&e));
    CHECK_EQ(pixels[13*16+8] >> 24, 0); /* gap rotates down */
    CHECK_EQ(pixels[8*16+13] >> 24, 255);
    memset(pixels,0,sizeof pixels);
    e.height=8; e.ring_cos=32768; e.ring_sin=0;
    CHECK(face_raster_eye(&s,&e)); /* ring radius follows width; bounding box may be non-square during a spring */
    CHECK_EQ(pixels[6*16+3] >> 24, 255);
}

static void test_low_alpha_white_stays_white(void)
{
    uint32_t pixel=0x0bffffffu; const uint8_t star=11;
    face_raster_surface_t s={.pixels=&pixel,.width=1,.height=1,.stride=1,.capacity=1};
    face_raster_eye_t e={.x=1,.y=1,.width=1,.height=1,.top_rgb=0,.bottom_rgb=0,
        .star_x=-1,.star_y=-1,.star_w=1,.star_h=1,.star_stride=1,.star_size=1,.star_data=&star,.star_opacity=255};
    CHECK(face_raster_eye(&s,&e));
    CHECK_EQ(pixel,0x16ffffffu);
}

static uint32_t random_word(uint32_t *state)
{
    *state = *state * 1664525u + 1013904223u;
    return *state;
}
static void test_clipped_random_frames_keep_guards(void)
{
    uint32_t storage[100], random=9;
    const uint8_t star[] = {0,255,128,64};
    for (int n=0; n<3000; ++n) {
        for (int i=0;i<100;++i) storage[i]=0xdeadbeefu;
        face_raster_surface_t s={.pixels=storage+11,.width=8,.height=8,.stride=10,.capacity=79};
        face_raster_eye_t e={.x=(int32_t)(random_word(&random)%33)-16,.y=(int32_t)(random_word(&random)%33)-16,
            .width=(int32_t)(random_word(&random)%16)+1,.height=(int32_t)(random_word(&random)%16)+1,
            .radius=(int32_t)(random_word(&random)%16),.top_rgb=0x123456,.bottom_rgb=0xaabbcc,
            .star_x=-2,.star_y=2,.star_w=2,.star_h=2,.star_stride=2,.star_size=4,.star_data=star,.star_opacity=200};
        if (n%3==1) { e.lid=FACE_RASTER_LID_SLANT; e.lid_y10=(int32_t)(random_word(&random)%200)-100;
                      e.lid_slope=(int32_t)(random_word(&random)%801)-400; }
        if (n%3==2) { e.lid=FACE_RASTER_LID_DOME; e.dome_cx=(int32_t)(random_word(&random)%33)-16;
                      e.dome_cy=(int32_t)(random_word(&random)%33)-16; e.dome_rx=8; e.dome_ry=7; }
        CHECK(face_raster_eye(&s,&e));
        for (int i=0;i<11;++i) CHECK_EQ(storage[i],0xdeadbeefu);
        for (int y=0;y<8;++y) { CHECK_EQ(storage[11+y*10+8],0xdeadbeefu); CHECK_EQ(storage[11+y*10+9],0xdeadbeefu); }
        for (int i=91;i<100;++i) CHECK_EQ(storage[i],0xdeadbeefu);
    }
}

int main(void)
{
    test_capsule_gradient_and_clipping();
    test_slanted_lid_and_star();
    test_reject_invalid_and_handle_partial_offscreen();
    test_dome_and_rotating_ring();
    test_star_overhang_and_opaque_lid();
    test_clipped_random_frames_keep_guards();
    test_low_alpha_white_stays_white();
    return g_failed ? 1 : 0;
}
