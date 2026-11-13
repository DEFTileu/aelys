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

static void test_allocation_free_bitmap_rotation(void)
{
    uint32_t source[25] = {0}, target[25];
    source[2*5+3]=0xffff0000u; source[1*5+2]=0x8000ff00u;
    face_raster_surface_t a={.pixels=source,.width=5,.height=5,.stride=5,.capacity=25};
    face_raster_surface_t b={.pixels=target,.width=5,.height=5,.stride=5,.capacity=25};
    CHECK(face_raster_rotate(&a,&b,2,2,32768,0));
    CHECK(!memcmp(source,target,sizeof source));
    CHECK(face_raster_rotate(&a,&b,2,2,0,32768));
    CHECK_EQ(target[3*5+2],0xffff0000u);
    CHECK_EQ(target[2*5+3],0x8000ff00u);
    uint32_t saved[25]; memcpy(saved,target,sizeof saved);
    CHECK(!face_raster_rotate(&a,&a,2,2,32768,0));
    b.capacity=24; CHECK(!face_raster_rotate(&a,&b,2,2,32768,0));
    CHECK(!memcmp(saved,target,sizeof saved));
    b.capacity=25; memset(source,0,sizeof source); source[2*5+3]=0x80ffffffu;
    CHECK(face_raster_rotate(&a,&b,2,2,23170,23170));
    for (unsigned i=0;i<25;++i) if (target[i]>>24) CHECK_EQ(target[i]&0xffffffu,0xffffffu);
    uint32_t overlap[26]={0}; face_raster_surface_t c={.pixels=overlap,.width=5,.height=5,.stride=5,.capacity=25};
    face_raster_surface_t d={.pixels=overlap+1,.width=5,.height=5,.stride=5,.capacity=25};
    CHECK(!face_raster_rotate(&c,&d,2,2,32768,0));
}

static void test_two_eye_composite_layer_order(void)
{
    uint32_t pixels[100] = {0}; const uint8_t star = 255;
    face_raster_surface_t s={.pixels=pixels,.width=10,.height=10,.stride=10,.capacity=100};
    face_raster_eye_t left={.x=1,.y=1,.width=6,.height=6,.top_rgb=0x990000,.bottom_rgb=0x990000,
        .star_x=4,.star_y=4,.star_w=1,.star_h=1,.star_stride=1,.star_size=1,.star_data=&star,.star_opacity=255,
        .lid=FACE_RASTER_LID_SLANT,.lid_y10=20};
    face_raster_eye_t right={.x=4,.y=1,.width=4,.height=6,.top_rgb=0x000099,.bottom_rgb=0x000099};
    CHECK(face_raster_eye_parts(&s,&left,FACE_RASTER_BODY));
    CHECK(face_raster_eye_parts(&s,&right,FACE_RASTER_BODY));
    CHECK_EQ(pixels[5*10+5],0xff000099u);
    CHECK(face_raster_eye_parts(&s,&left,FACE_RASTER_HIGHLIGHT));
    CHECK_EQ(pixels[5*10+5],0xffffffffu);
    CHECK(face_raster_eye_parts(&s,&left,FACE_RASTER_MASK));
    CHECK_EQ(pixels[2*10+5],0xff000000u);
    uint32_t before[100]; memcpy(before,pixels,sizeof pixels);
    CHECK(!face_raster_eye_parts(&s,&left,8u));
    CHECK(!memcmp(before,pixels,sizeof pixels));
    CHECK(!face_raster_eye_parts(&s,&left,0));
    CHECK(!memcmp(before,pixels,sizeof pixels));

    uint32_t combined[100] = {0}, separated[100] = {0};
    face_raster_surface_t a={.pixels=combined,.width=10,.height=10,.stride=10,.capacity=100};
    face_raster_surface_t b={.pixels=separated,.width=10,.height=10,.stride=10,.capacity=100};
    CHECK(face_raster_eye(&a,&left));
    CHECK(face_raster_eye_parts(&b,&left,FACE_RASTER_BODY));
    CHECK(face_raster_eye_parts(&b,&left,FACE_RASTER_HIGHLIGHT));
    CHECK(face_raster_eye_parts(&b,&left,FACE_RASTER_MASK));
    CHECK(!memcmp(combined,separated,sizeof combined));
}

static void test_explicit_slanted_mask_bounds(void)
{
    uint32_t pixels[100] = {0};
    face_raster_surface_t s={.pixels=pixels,.width=10,.height=10,.stride=10,.capacity=100};
    face_raster_eye_t e={.x=4,.y=3,.width=4,.height=6,.top_rgb=0x8040c0,.bottom_rgb=0x8040c0,
        .lid=FACE_RASTER_LID_SLANT,.lid_y10=20,.lid_bounds_set=true,
        .lid_x=0,.lid_y=1,.lid_width=10,.lid_height=4};
    CHECK(face_raster_eye_parts(&s,&e,FACE_RASTER_MASK));
    CHECK_EQ(pixels[2*10],0xff000000u);
    CHECK_EQ(pixels[2*10+9],0xff000000u);
    CHECK_EQ(pixels[0],0);
    CHECK_EQ(pixels[5*10+4],0);
    memset(pixels,0,sizeof pixels);
    e.lid_x=-2; e.lid_width=8; e.lid_height=6; e.lid_slope=500;
    CHECK(face_raster_eye_parts(&s,&e,FACE_RASTER_MASK));
    CHECK_EQ(pixels[3*10],0);             /* clipped left edge, below the slope */
    CHECK_EQ(pixels[3*10+5],0xff000000u);
    CHECK_EQ(pixels[3*10+6],0);           /* outside explicit right edge */
    uint32_t before[100]; memcpy(before,pixels,sizeof pixels);
    e.lid_width=0;
    CHECK(!face_raster_eye_parts(&s,&e,FACE_RASTER_MASK));
    CHECK(!memcmp(before,pixels,sizeof pixels));
    e.lid_width=10; e.lid_x=INT32_MIN; e.lid_y=INT32_MAX;
    CHECK(face_raster_eye_parts(&s,&e,FACE_RASTER_MASK));
    CHECK(!memcmp(before,pixels,sizeof pixels));
}

static void test_rotation_interpolates_alpha_and_color(void)
{
    /* At 45 degrees, destination (2,1) samples (1.707,0.293).
       Transparent blue and white must not contaminate the red/green blend. */
    uint32_t src[9]={0,0xffff0000u,0x8000ff00u,0,0x000000ffu,0x00ffffffu,0,0,0};
    uint32_t dst[9]={0};
    face_raster_surface_t a={.pixels=src,.width=3,.height=3,.stride=3,.capacity=9};
    face_raster_surface_t b={.pixels=dst,.width=3,.height=3,.stride=3,.capacity=9};
    CHECK(face_raster_rotate(&a,&b,1,1,23170,23170));
    CHECK_EQ(dst[5],0x75738c00u);
    /* Composited over opaque blue, the sample remains partly transparent. */
    unsigned alpha=dst[5]>>24;
    CHECK_EQ((((dst[5]>>16)&255u)*alpha+127)/255,53);
    CHECK_EQ((((dst[5]>>8)&255u)*alpha+127)/255,64);
    CHECK_EQ(255-alpha,138);
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
                      e.lid_slope=(int32_t)(random_word(&random)%801)-400;
                      if (n%2) { e.lid_bounds_set=true; e.lid_x=(int32_t)(random_word(&random)%33)-16;
                                 e.lid_y=(int32_t)(random_word(&random)%33)-16; e.lid_width=10; e.lid_height=9; } }
        if (n%3==2) { e.lid=FACE_RASTER_LID_DOME; e.dome_cx=(int32_t)(random_word(&random)%33)-16;
                      e.dome_cy=(int32_t)(random_word(&random)%33)-16; e.dome_rx=8; e.dome_ry=7; }
        CHECK(face_raster_eye(&s,&e));
        for (int i=0;i<11;++i) CHECK_EQ(storage[i],0xdeadbeefu);
        for (int y=0;y<8;++y) { CHECK_EQ(storage[11+y*10+8],0xdeadbeefu); CHECK_EQ(storage[11+y*10+9],0xdeadbeefu); }
        for (int i=91;i<100;++i) CHECK_EQ(storage[i],0xdeadbeefu);
    }
}

static void check_bounds(face_raster_eye_t *e, unsigned parts, int64_t l, int64_t t, int64_t r, int64_t b)
{
    face_raster_bounds_t bounds = {99, 99, 99, 99};
    CHECK(face_raster_eye_bounds(e, parts, &bounds));
    CHECK(bounds.left == l && bounds.top == t && bounds.right == r && bounds.bottom == b);
}

static void test_descriptor_bounds(void)
{
    const uint8_t star[6]={255,255,255,255,255,255};
    face_raster_eye_t e={.x=10,.y=20,.width=8,.height=6,
        .star_x=-4,.star_y=7,.star_w=3,.star_h=2,.star_stride=3,.star_size=6,.star_data=star,
        .lid=FACE_RASTER_LID_DOME,.dome_cx=30,.dome_cy=40,.dome_rx=4,.dome_ry=5};
    check_bounds(&e,FACE_RASTER_BODY,10,20,18,26);
    check_bounds(&e,FACE_RASTER_HIGHLIGHT,6,27,9,29);
    check_bounds(&e,FACE_RASTER_MASK,26,35,34,45);
    check_bounds(&e,FACE_RASTER_ALL,6,20,34,45);
    e.lid=FACE_RASTER_LID_SLANT; e.lid_y10=-19; e.lid_slope=-500;
    check_bounds(&e,FACE_RASTER_MASK,8,14,20,24);
    e.lid_bounds_set=true; e.lid_x=-7; e.lid_y=2; e.lid_width=3; e.lid_height=4;
    check_bounds(&e,FACE_RASTER_MASK,-7,2,-4,6);
    e.lid_bounds_set=false; e.lid_y10=-4096; e.lid_slope=0;
    check_bounds(&e,FACE_RASTER_MASK,0,0,0,0);
    e.lid=FACE_RASTER_LID_NONE; check_bounds(&e,FACE_RASTER_MASK,0,0,0,0);
    e.x=INT32_MAX; e.y=INT32_MIN; e.star_x=INT32_MAX; e.star_y=INT32_MIN;
    check_bounds(&e,FACE_RASTER_HIGHLIGHT,4294967294LL,-4294967296LL,4294967297LL,-4294967294LL);
    check_bounds(&e,FACE_RASTER_BODY,INT32_MAX,INT32_MIN,2147483655LL,-2147483642LL);
    face_raster_bounds_t before={1,2,3,4}, out=before;
    CHECK(!face_raster_eye_bounds(&e,0,&out)); CHECK(!memcmp(&before,&out,sizeof out));
    CHECK(!face_raster_eye_bounds(&e,8,&out)); CHECK(!memcmp(&before,&out,sizeof out));
    CHECK(!face_raster_eye_bounds(NULL,FACE_RASTER_BODY,&out)); CHECK(!memcmp(&before,&out,sizeof out));
    CHECK(!face_raster_eye_bounds(&e,FACE_RASTER_BODY,NULL));
    e.width=0; CHECK(!face_raster_eye_bounds(&e,FACE_RASTER_BODY,&out)); CHECK(!memcmp(&before,&out,sizeof out));
    e.width=8; e.star_size=5; CHECK(!face_raster_eye_bounds(&e,FACE_RASTER_BODY,&out)); CHECK(!memcmp(&before,&out,sizeof out));
    e.star_size=6; e.lid=FACE_RASTER_LID_DOME; e.dome_rx=0;
    CHECK(!face_raster_eye_bounds(&e,FACE_RASTER_BODY,&out)); CHECK(!memcmp(&before,&out,sizeof out));
    e.lid=FACE_RASTER_LID_SLANT; e.lid_bounds_set=true; e.lid_width=0;
    CHECK(!face_raster_eye_bounds(&e,FACE_RASTER_BODY,&out)); CHECK(!memcmp(&before,&out,sizeof out));
    e.lid_bounds_set=false; e.kind=FACE_RASTER_RING; e.border=0;
    CHECK(!face_raster_eye_bounds(&e,FACE_RASTER_BODY,&out)); CHECK(!memcmp(&before,&out,sizeof out));
    e.kind=FACE_RASTER_PILL; e.lid=FACE_RASTER_LID_DOME;
    e.dome_cx=INT32_MIN; e.dome_cy=INT32_MAX; e.dome_rx=4096; e.dome_ry=4096;
    check_bounds(&e,FACE_RASTER_MASK,-2147487744LL,2147479551LL,-2147479552LL,2147487743LL);
}

static void test_random_bounds_contain_rendered_pixels(void)
{
    uint32_t random=123, pixels[32*32]; const uint8_t star[4]={255,128,64,255};
    face_raster_surface_t s={.pixels=pixels,.width=32,.height=32,.stride=32,.capacity=1024};
    for (int n=0;n<4000;++n) {
        face_raster_eye_t e={.x=(int32_t)(random_word(&random)%65)-24,.y=(int32_t)(random_word(&random)%65)-24,
            .width=(int32_t)(random_word(&random)%20)+1,.height=(int32_t)(random_word(&random)%20)+1,
            .radius=(int32_t)(random_word(&random)%20),.top_rgb=0xffffff,.bottom_rgb=0xffffff,
            .star_x=(int32_t)(random_word(&random)%25)-12,.star_y=(int32_t)(random_word(&random)%25)-12,
            .star_w=2,.star_h=2,.star_stride=2,.star_size=4,.star_data=star,.star_opacity=255};
        if (n%3==1) { e.lid=FACE_RASTER_LID_SLANT; e.lid_y10=(int32_t)(random_word(&random)%201)-100;
            e.lid_slope=(int32_t)(random_word(&random)%4001)-2000;
            if (n%2) { e.lid_bounds_set=true; e.lid_x=(int32_t)(random_word(&random)%65)-24;
                e.lid_y=(int32_t)(random_word(&random)%65)-24; e.lid_width=13; e.lid_height=11; } }
        if (n%3==2) { e.lid=FACE_RASTER_LID_DOME; e.dome_cx=(int32_t)(random_word(&random)%65)-24;
            e.dome_cy=(int32_t)(random_word(&random)%65)-24; e.dome_rx=8; e.dome_ry=7; }
        if (n%4==0 && e.width>=2) { e.kind=FACE_RASTER_RING; e.border=1; e.ring_cos=32768; }
        for (unsigned parts=1;parts<=FACE_RASTER_ALL;++parts) {
            face_raster_bounds_t b; memset(pixels,0,sizeof pixels);
            CHECK(face_raster_eye_bounds(&e,parts,&b)); CHECK(face_raster_eye_parts(&s,&e,parts));
            for (int y=0;y<32;++y) for (int x=0;x<32;++x)
                if (pixels[y*32+x]) CHECK(x>=b.left && x<b.right && y>=b.top && y<b.bottom);
        }
    }
}

int main(void)
{
    test_descriptor_bounds();
    test_random_bounds_contain_rendered_pixels();
    test_capsule_gradient_and_clipping();
    test_slanted_lid_and_star();
    test_reject_invalid_and_handle_partial_offscreen();
    test_dome_and_rotating_ring();
    test_star_overhang_and_opaque_lid();
    test_clipped_random_frames_keep_guards();
    test_low_alpha_white_stays_white();
    test_allocation_free_bitmap_rotation();
    test_two_eye_composite_layer_order();
    test_explicit_slanted_mask_bounds();
    test_rotation_interpolates_alpha_and_color();
    return g_failed ? 1 : 0;
}
