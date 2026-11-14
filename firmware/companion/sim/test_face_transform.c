#include <stdint.h>
#include <string.h>
#include "check.h"
#include "sim_display.h"
#include "ui_face_transform.h"

enum { W=120, H=120, X=160, Y=160 };
static uint32_t source[W*H], dest[W*H], padded[(W+1)*H];
static uint16_t reference[W*H];
typedef struct { uint32_t before[16], pixels[512*512], after[16]; } guarded_t;
static guarded_t max_source, max_dest;

static void test_maximum_bounds(void)
{
    for (unsigned i=0;i<16;++i) {
        max_source.before[i]=max_dest.before[i]=0x13579bdfu;
        max_source.after[i]=max_dest.after[i]=0x2468ace0u;
    }
    for (unsigned i=0;i<512u*512u;++i) max_source.pixels[i]=0x80a08040u;
    face_raster_surface_t a={.pixels=max_source.pixels,.width=512,.height=512,.stride=512,.capacity=512u*512u};
    face_raster_surface_t b={.pixels=max_dest.pixels,.width=512,.height=512,.stride=512,.capacity=512u*512u};
    const int angles[]={-3599,-900,900,1799,3599};
    for (unsigned n=0;n<sizeof angles/sizeof *angles;++n) {
        CHECK(face_lvgl_rotate(&a,&b,n%2?511:0,n%2?0:511,angles[n]));
        for (unsigned i=0;i<16;++i) {
            CHECK_EQ(max_source.before[i],0x13579bdfu); CHECK_EQ(max_source.after[i],0x2468ace0u);
            CHECK_EQ(max_dest.before[i],0x13579bdfu); CHECK_EQ(max_dest.after[i],0x2468ace0u);
        }
    }
}

static void snapshot(void)
{
    const uint16_t *fb=sim_fb();
    for (int y=0; y<H; ++y) memcpy(reference+y*W, fb+(Y+y)*SIM_W+X, W*sizeof(uint16_t));
}

static void test_expanded_rotation(void)
{
    static uint32_t input[6*4], output[12*12];
    for (unsigned i=0;i<24;++i) input[i]=0xffff0000u;
    face_raster_surface_t s={.pixels=input,.width=6,.height=4,.stride=6,.capacity=24};
    face_raster_surface_t d={.pixels=output,.width=12,.height=12,.stride=12,.capacity=144};
    lv_draw_buf_t sb,db;
    CHECK_EQ(lv_draw_buf_init(&sb,6,4,LV_COLOR_FORMAT_ARGB8888,24,input,sizeof input),LV_RESULT_OK);
    CHECK_EQ(lv_draw_buf_init(&db,12,12,LV_COLOR_FORMAT_ARGB8888,48,output,sizeof output),LV_RESULT_OK);
    lv_draw_buf_set_flag(&sb,LV_IMAGE_FLAGS_ALLOCATED); lv_draw_buf_set_flag(&db,LV_IMAGE_FLAGS_ALLOCATED);
    lv_obj_t *screen=lv_screen_active();
    lv_obj_t *image=lv_image_create(screen); lv_obj_remove_style_all(image);
    lv_obj_set_pos(image,X+3,Y+4); lv_image_set_src(image,&sb); lv_image_set_pivot(image,3,2); lv_image_set_rotation(image,900);
    lv_obj_invalidate(screen); sim_step(30);
    uint16_t ref[12*12]; const uint16_t *fb=sim_fb();
    unsigned outside=0; uint16_t background=fb[(Y-1)*SIM_W+X];
    for (int y=0;y<12;++y) for (int x=0;x<12;++x) {
        ref[y*12+x]=fb[(Y+y)*SIM_W+X+x];
        if ((x<3 || x>=9 || y<4 || y>=8) && ref[y*12+x]!=background) outside++;
    }
    CHECK(outside>0);
    CHECK(face_lvgl_rotate_region(&s,&d,3,2,900,-3,-4));
    lv_image_set_rotation(image,0); lv_image_set_src(image,&db); lv_obj_set_pos(image,X,Y);
    lv_obj_invalidate(screen); sim_step(30);
    unsigned diff=0;
    for (int y=0;y<12;++y) for (int x=0;x<12;++x) diff += ref[y*12+x]!=fb[(Y+y)*SIM_W+X+x];
    CHECK_EQ(diff,0);
    lv_obj_delete(image);
    CHECK(face_lvgl_rotate_region(&s,&d,3,2,0,-3,-4));
    for (int y=0;y<12;++y) for (int x=0;x<12;++x)
        CHECK_EQ(output[y*12+x],(x>=3 && x<9 && y>=4 && y<8)?0xffff0000u:0u);
    uint32_t before[144]; memcpy(before,output,sizeof before);
    CHECK(!face_lvgl_rotate_region(&s,&d,3,2,900,-513,0));
    CHECK(!face_lvgl_rotate_region(&s,&d,3,2,900,0,512));
    CHECK(!memcmp(before,output,sizeof before));
}

static void test_rotated_bounds_contain_pixels(void)
{
    static uint32_t input[40*40], output[160*160];
    for (unsigned i=0;i<40u*40u;++i) input[i]=0xffffffffu;
    uint32_t random=0x142857u;
    for (int n=0;n<240;++n) {
        random=random*1664525u+1013904223u; uint32_t w=1+random%40;
        random=random*1664525u+1013904223u; uint32_t h=1+random%40;
        random=random*1664525u+1013904223u; int px=(int)(random%w);
        random=random*1664525u+1013904223u; int py=(int)(random%h);
        random=random*1664525u+1013904223u; int angle=(int)(random%7199)-3599;
        face_raster_bounds_t bound;
        face_raster_surface_t s={.pixels=input,.width=w,.height=h,.stride=40,.capacity=40u*40u};
        face_raster_surface_t d={.pixels=output,.width=160,.height=160,.stride=160,.capacity=160u*160u};
        CHECK(face_lvgl_rotation_bounds(w,h,px,py,angle,&bound));
        CHECK(face_lvgl_rotate_region(&s,&d,px,py,angle,-80,-80));
        for (int y=0;y<160;++y) for (int x=0;x<160;++x)
            if (output[y*160+x]>>24)
                CHECK((x-80)>=bound.left && (x-80)<bound.right && (y-80)>=bound.top && (y-80)<bound.bottom);
    }
    face_raster_surface_t small={.pixels=input,.width=8,.height=6,.stride=40,.capacity=40u*40u};
    face_raster_surface_t tile={.pixels=output,.width=64,.height=64,.stride=64,.capacity=160u*160u};
    for (int pivot=0;pivot<2;++pivot) for (int angle=0;angle<3600;++angle) {
        int px=pivot?7:0, py=pivot?5:0;
        face_raster_bounds_t bound;
        CHECK(face_lvgl_rotation_bounds(8,6,px,py,angle,&bound));
        if (angle) {
            face_raster_bounds_t equivalent;
            CHECK(face_lvgl_rotation_bounds(8,6,px,py,angle-3600,&equivalent));
            CHECK(!memcmp(&bound,&equivalent,sizeof bound));
        }
        CHECK(face_lvgl_rotate_region(&small,&tile,px,py,angle,-24,-24));
        for (int y=0;y<64;++y) for (int x=0;x<64;++x)
            if (output[y*64+x]>>24)
                CHECK((x-24)>=bound.left && (x-24)<bound.right && (y-24)>=bound.top && (y-24)<bound.bottom);
    }
    face_raster_bounds_t b={7,8,9,10};
    CHECK(face_lvgl_rotation_bounds(40,20,5,9,0,&b));
    CHECK_EQ(b.left,0); CHECK_EQ(b.top,0); CHECK_EQ(b.right,40); CHECK_EQ(b.bottom,20);
    face_raster_bounds_t saved=b;
    CHECK(!face_lvgl_rotation_bounds(513,20,5,9,0,&b));
    CHECK(!face_lvgl_rotation_bounds(40,20,40,9,0,&b));
    CHECK(!face_lvgl_rotation_bounds(40,20,5,9,3600,&b));
    CHECK(!memcmp(&b,&saved,sizeof b));

    /* Known visible pixel two rows outside LVGL's forward corner rectangle. */
    static uint32_t large[467*457], column[71];
    for (unsigned i=0;i<467u*457u;++i) large[i]=0xffffffffu;
    face_raster_surface_t s={.pixels=large,.width=467,.height=457,.stride=467,.capacity=467u*457u};
    face_raster_surface_t d={.pixels=column,.width=1,.height=71,.stride=1,.capacity=71};
    CHECK(face_lvgl_rotation_bounds(467,457,83,0,529,&b));
    CHECK(face_lvgl_rotate_region(&s,&d,83,0,529,-50,511));
    CHECK(column[70]>>24);
    CHECK(-50>=b.left && -50<b.right && 581>=b.top && 581<b.bottom);
    CHECK(face_lvgl_rotation_bounds(512,512,511,0,-1350,&b));
    CHECK(1200>=b.left && 1200<b.right && 0>=b.top && 0<b.bottom);
}

int main(void)
{
    sim_init(); sim_partial();
    for (int y=20; y<95; ++y) for (int x=20; x<100; ++x) {
        unsigned a=(x+y)%7 ? 25u+(unsigned)(x*7+y*3)%230u : 255u;
        source[y*W+x]=(a<<24)|((255u-(unsigned)(x*2+y)%256u)<<16)|((unsigned)(x*5+y*2)%256u<<8)|((unsigned)(x*3+y*5)%256u);
    }
    face_raster_surface_t s={.pixels=source,.width=W,.height=H,.stride=W,.capacity=W*H};
    face_raster_surface_t d={.pixels=dest,.width=W,.height=H,.stride=W,.capacity=W*H};
    lv_draw_buf_t sb,db;
    CHECK_EQ(lv_draw_buf_init(&sb,W,H,LV_COLOR_FORMAT_ARGB8888,W*4,source,sizeof source),LV_RESULT_OK);
    CHECK_EQ(lv_draw_buf_init(&db,W,H,LV_COLOR_FORMAT_ARGB8888,W*4,dest,sizeof dest),LV_RESULT_OK);
    lv_draw_buf_set_flag(&sb,LV_IMAGE_FLAGS_ALLOCATED); lv_draw_buf_set_flag(&db,LV_IMAGE_FLAGS_ALLOCATED);
    lv_obj_t *screen=lv_screen_active();
    lv_obj_set_style_bg_color(screen,lv_color_make(24,64,112),0); lv_obj_set_style_bg_opa(screen,LV_OPA_COVER,0);
    lv_obj_t *image=lv_image_create(screen); lv_obj_remove_style_all(image); lv_obj_set_pos(image,X,Y);
    lv_image_set_pivot(image,W/2,H/2);
    const int angles[]={0,35,90,-90,-37,900,-900,1800};
    for (unsigned n=0;n<sizeof angles/sizeof *angles;++n) {
        lv_image_set_src(image,&sb); lv_image_set_rotation(image,angles[n]<0?3600+angles[n]:angles[n]);
        lv_obj_invalidate(screen); sim_step(30); snapshot();
        CHECK(face_lvgl_rotate(&s,&d,W/2,H/2,angles[n]));
        lv_image_set_rotation(image,0); lv_image_set_src(image,&db);
        lv_obj_invalidate(screen); sim_step(30);
        unsigned diff=0;
        const uint16_t *fb=sim_fb();
        for (int y=0;y<H;++y) for (int x=0;x<W;++x) diff += reference[y*W+x] != fb[(Y+y)*SIM_W+X+x];
        CHECK_EQ(diff,0);
    }
    CHECK(face_lvgl_rotate(&s,&d,W/2,H/2,35));
    uint32_t before[W*H]; memcpy(before,dest,sizeof dest);
    for (int y=0;y<H;++y) memcpy(padded+y*(W+1),source+y*W,W*sizeof(uint32_t));
    face_raster_surface_t padded_s={.pixels=padded,.width=W,.height=H,.stride=W+1,.capacity=(W+1)*H};
    CHECK(face_lvgl_rotate(&padded_s,&d,W/2,H/2,35));
    CHECK(!memcmp(before,dest,sizeof dest));
    test_maximum_bounds();
    CHECK(!face_lvgl_rotate(&s,&s,W/2,H/2,35));
    face_raster_surface_t overlap={.pixels=source+1,.width=W,.height=H,.stride=W,.capacity=W*H};
    CHECK(!face_lvgl_rotate(&s,&overlap,W/2,H/2,35));
    d.capacity=W*H-1; CHECK(!face_lvgl_rotate(&s,&d,W/2,H/2,35)); d.capacity=W*H;
    d.stride=W+1; CHECK(!face_lvgl_rotate(&s,&d,W/2,H/2,35)); d.stride=W;
    CHECK(!face_lvgl_rotate(&s,&d,W/2,H/2,3600));
    CHECK(!face_lvgl_rotate(&s,&d,-1,0,35));
    CHECK(!face_lvgl_rotate(&s,&d,W,0,35));
    s.stride=UINT32_MAX; CHECK(!face_lvgl_rotate(&s,&d,0,0,35)); s.stride=W;
    d.pixels=(uint32_t *)((uint8_t *)dest+1); CHECK(!face_lvgl_rotate(&s,&d,0,0,35)); d.pixels=dest;
    face_raster_surface_t large_s={.pixels=source,.width=513,.height=1,.stride=513,.capacity=513};
    face_raster_surface_t large_d={.pixels=dest,.width=513,.height=1,.stride=513,.capacity=513};
    CHECK(!face_lvgl_rotate(&large_s,&large_d,0,0,35));
    CHECK(!memcmp(before,dest,sizeof dest));
    lv_obj_delete(image);
    test_expanded_rotation();
    test_rotated_bounds_contain_pixels();
    return g_failed ? 1 : 0;
}
