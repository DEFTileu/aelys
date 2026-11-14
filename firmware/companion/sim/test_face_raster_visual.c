/* Compare allocation-free eye primitives with existing LVGL shapes before
 * attempting to use them for rotation. The output is not yet wired to UI. */
#include <stdint.h>
#include <string.h>
#include "check.h"
#include "sim_display.h"
#include "face_raster.h"
#include "ui_face_priv.h"

static uint32_t image_data[390*221];
static uint32_t rotated_data[390*221];
static uint16_t reference[SIM_W*SIM_H];
static int scaled(int value, int scale) { return (value*scale + 50)/100; }
static void compare(mood_t mood, face_raster_eye_t eye, int scale)
{
    int width=scaled(300,scale), height=scaled(170,scale);
    lv_obj_t *face=face_create(lv_screen_active(),scale);
    lv_obj_set_pos(face,30,120); face_set_mood(face,mood);
    sim_step(20); lv_refr_now(NULL);
    memcpy(reference,sim_fb(),sizeof reference);
    lv_obj_delete(face); sim_step(20);
    memset(image_data,0,sizeof image_data);
    face_raster_surface_t surface={.pixels=image_data,.width=(uint32_t)width,.height=(uint32_t)height,
        .stride=(uint32_t)width,.capacity=390*221};
    eye.x=scaled(eye.x,scale); eye.y=scaled(eye.y,scale);
    eye.width=scaled(eye.width,scale); eye.height=scaled(eye.height,scale); eye.radius=scaled(eye.radius,scale);
    eye.star_x=scaled(eye.star_x,scale); eye.star_y=scaled(eye.star_y,scale);
    eye.lid_y10=scaled(eye.lid_y10,scale); eye.dome_cy=scaled(eye.dome_cy,scale);
    eye.dome_rx=scaled(eye.dome_rx,scale); eye.dome_ry=scaled(eye.dome_ry,scale);
    const lv_image_dsc_t *star=face_img_star(scaled(20,scale));
    eye.star_w=star->header.w; eye.star_h=star->header.h; eye.star_stride=star->header.stride;
    eye.star_size=star->data_size; eye.star_data=star->data; eye.star_opacity=255;
    if (eye.lid==FACE_RASTER_LID_DOME) eye.dome_cx=scaled(93,scale);
    CHECK(face_raster_eye(&surface,&eye));
    eye.x=scaled(172,scale);
    if (eye.lid==FACE_RASTER_LID_DOME) eye.dome_cx=scaled(207,scale);
    if (eye.lid==FACE_RASTER_LID_SLANT) eye.lid_slope=-eye.lid_slope;
    CHECK(face_raster_eye(&surface,&eye));
    lv_draw_buf_t buf;
    CHECK_EQ(lv_draw_buf_init(&buf,(uint32_t)width,(uint32_t)height,LV_COLOR_FORMAT_ARGB8888,0,image_data,sizeof image_data),LV_RESULT_OK);
    lv_draw_buf_set_flag(&buf,LV_IMAGE_FLAGS_MODIFIABLE);
    lv_obj_t *image=lv_image_create(lv_screen_active()); lv_image_set_src(image,&buf); lv_obj_set_pos(image,30,120);
    sim_step(20); lv_refr_now(NULL);
    unsigned ref_lit=0, out_lit=0, overlap=0, severe=0;
    uint64_t color_error=0;
    for (int y=120;y<120+height;y++) for (int x=30;x<30+width;x++) {
        unsigned a=reference[y*SIM_W+x], b=sim_fb()[y*SIM_W+x];
        bool la=a!=0, lb=b!=0; ref_lit+=la; out_lit+=lb; overlap+=la&&lb;
        if (la!=lb) severe++;
        if (la && lb) {
            int dr=(int)((a>>11)&31)-(int)((b>>11)&31);
            int dg=(int)((a>>5)&63)-(int)((b>>5)&63);
            int db=(int)(a&31)-(int)(b&31);
            color_error += (uint64_t)(dr<0?-dr:dr) + (uint64_t)(dg<0?-dg:dg) + (uint64_t)(db<0?-db:db);
        }
    }
    fprintf(stderr,"%s@%d: reference=%u raster=%u overlap=%u silhouette=%u color-error=%llu\n",
            mood_name(mood),scale,ref_lit,out_lit,overlap,severe,(unsigned long long)color_error);
    CHECK(ref_lit>100 && out_lit>100);
    CHECK(severe < (unsigned)(width*height/80+100));
    CHECK(color_error < (uint64_t)overlap * 3);
    lv_obj_delete(image); sim_step(20);
}
static int arc_phase;
static void arc_draw(lv_event_t *event)
{
    lv_area_t a; lv_obj_get_coords(lv_event_get_target_obj(event),&a);
    lv_draw_arc_dsc_t arc; lv_draw_arc_dsc_init(&arc);
    arc.color=lv_color_hex(0xa98cfb); arc.width=12;
    arc.center.x=(a.x1+a.x2+1)/2; arc.center.y=(a.y1+a.y2+1)/2;
    arc.radius=(uint16_t)((a.x2-a.x1+1)/2); arc.start_angle=(45+arc_phase)%360; arc.end_angle=(315+arc_phase)%360;
    lv_draw_arc(lv_event_get_layer(event),&arc);
}
static void compare_ring(int phase)
{
    arc_phase=phase;
    lv_obj_t *shape=lv_obj_create(lv_screen_active());
    lv_obj_set_style_bg_opa(shape,LV_OPA_TRANSP,0); lv_obj_set_style_border_width(shape,0,0);
    lv_obj_set_pos(shape,80,140); lv_obj_set_size(shape,76,76);
    lv_obj_add_event_cb(shape,arc_draw,LV_EVENT_DRAW_MAIN,NULL);
    sim_step(20); lv_refr_now(NULL); memcpy(reference,sim_fb(),sizeof reference);
    lv_obj_delete(shape); sim_step(20); memset(image_data,0,sizeof image_data);
    face_raster_surface_t surface={.pixels=image_data,.width=300,.height=170,.stride=300,.capacity=300*170};
    face_raster_eye_t ring={.x=0,.y=0,.width=76,.height=76,.kind=FACE_RASTER_RING,.border=12,
        .ring_cos=lv_trigo_cos((int16_t)phase),.ring_sin=lv_trigo_sin((int16_t)phase),.top_rgb=0xa98cfb,.bottom_rgb=0xa98cfb};
    CHECK(face_raster_eye(&surface,&ring));
    lv_draw_buf_t buf;
    CHECK_EQ(lv_draw_buf_init(&buf,300,170,LV_COLOR_FORMAT_ARGB8888,0,image_data,sizeof image_data),LV_RESULT_OK);
    lv_draw_buf_set_flag(&buf,LV_IMAGE_FLAGS_MODIFIABLE);
    lv_obj_t *image=lv_image_create(lv_screen_active()); lv_image_set_src(image,&buf); lv_obj_set_pos(image,80,140);
    sim_step(20); lv_refr_now(NULL);
    unsigned a_count=0,b_count=0,overlap=0,diff=0;
    for (int y=140;y<216;y++) for (int x=80;x<156;x++) {
        bool a=reference[y*SIM_W+x]!=0,b=sim_fb()[y*SIM_W+x]!=0;
        a_count+=a;b_count+=b;overlap+=a&&b;diff+=a!=b;
    }
    fprintf(stderr,"ring %d: reference=%u raster=%u overlap=%u silhouette=%u\n",phase,a_count,b_count,overlap,diff);
    CHECK(a_count>1000 && b_count>1000);
    CHECK(diff<500);
    lv_obj_delete(image); sim_step(20);
}
static void compare_software_rotation(int degrees)
{
    memset(image_data,0,sizeof image_data); memset(rotated_data,0,sizeof rotated_data);
    face_raster_surface_t src={.pixels=image_data,.width=300,.height=170,.stride=300,.capacity=390*221};
    face_raster_surface_t dst={.pixels=rotated_data,.width=300,.height=170,.stride=300,.capacity=390*221};
    face_raster_eye_t eye={.x=58,.y=35,.width=70,.height=100,.radius=35,.top_rgb=0xcdbfff,.bottom_rgb=0x7c58f4};
    CHECK(face_raster_eye(&src,&eye)); eye.x=172; CHECK(face_raster_eye(&src,&eye));
    lv_draw_buf_t sb,db;
    CHECK_EQ(lv_draw_buf_init(&sb,300,170,LV_COLOR_FORMAT_ARGB8888,0,image_data,sizeof image_data),LV_RESULT_OK);
    CHECK_EQ(lv_draw_buf_init(&db,300,170,LV_COLOR_FORMAT_ARGB8888,0,rotated_data,sizeof rotated_data),LV_RESULT_OK);
    lv_draw_buf_set_flag(&sb,LV_IMAGE_FLAGS_MODIFIABLE); lv_draw_buf_set_flag(&db,LV_IMAGE_FLAGS_MODIFIABLE);
    lv_obj_t *image=lv_image_create(lv_screen_active()); lv_image_set_src(image,&sb); lv_obj_set_pos(image,80,140);
    lv_image_set_pivot(image,150,85); lv_image_set_rotation(image,degrees*10);
    sim_step(20); lv_refr_now(NULL); memcpy(reference,sim_fb(),sizeof reference);
    lv_obj_delete(image); sim_step(20);
    CHECK(face_raster_rotate(&src,&dst,150,85,lv_trigo_cos((int16_t)degrees),lv_trigo_sin((int16_t)degrees)));
    image=lv_image_create(lv_screen_active()); lv_image_set_src(image,&db); lv_obj_set_pos(image,80,140);
    sim_step(20); lv_refr_now(NULL);
    unsigned ref_lit=0,out_lit=0,overlap=0,mismatch=0;
    for (int y=120;y<330;y++) for (int x=60;x<400;x++) {
        bool a=reference[y*SIM_W+x]!=0,b=sim_fb()[y*SIM_W+x]!=0;
        ref_lit+=a;out_lit+=b;overlap+=a&&b;mismatch+=a!=b;
    }
    fprintf(stderr,"rotation %d: reference=%u raster=%u overlap=%u silhouette=%u\n",degrees,ref_lit,out_lit,overlap,mismatch);
    CHECK(ref_lit>10000 && out_lit>10000);
    CHECK(mismatch<100);
    lv_obj_delete(image); sim_step(20);
}
int main(void)
{
    sim_init(); sim_direct();
    face_raster_eye_t eye={.x=58,.y=35,.width=70,.height=100,.radius=35,
        .top_rgb=0xcdbfff,.bottom_rgb=0x7c58f4,.star_x=38,.star_y=14};
    compare(MOOD_CALM,eye,100);
    compare(MOOD_CALM,eye,130);
    compare(MOOD_CALM,eye,34);
    eye.lid=FACE_RASTER_LID_DOME; eye.dome_cy=135; eye.dome_rx=49; eye.dome_ry=48;
    compare(MOOD_HAPPY,eye,100);
    compare(MOOD_HAPPY,eye,130);
    eye.lid=FACE_RASTER_LID_SLANT; eye.y=42; eye.height=92; eye.lid_y10=253; eye.lid_slope=-287;
    compare(MOOD_WORRIED,eye,100);
    compare(MOOD_WORRIED,eye,130);
    const int phases[] = {0,45,90,135,180,225,270,315};
    for (unsigned i=0;i<sizeof phases/sizeof *phases;++i) compare_ring(phases[i]);
    const int angles[] = {-9,-7,-4,4,6,9};
    for (unsigned i=0;i<sizeof angles/sizeof *angles;++i) compare_software_rotation(angles[i]);
    return g_failed ? 1 : 0;
}
