#include "ui_face_transform.h"
#include <limits.h>
#include <stdint.h>
#include <string.h>
#include "lvgl.h"
#if LVGL_VERSION_MAJOR == 9 && LVGL_VERSION_MINOR == 6 && LVGL_VERSION_PATCH == 0 && \
    LV_USE_DRAW_SW && LV_DRAW_SW_SUPPORT_ARGB8888 && !LV_DRAW_SW_SUPPORT_ARGB8888_PREMULTIPLIED
#define FACE_TRANSFORM_SUPPORTED 1
#include "src/draw/sw/lv_draw_sw.h"
#else
#define FACE_TRANSFORM_SUPPORTED 0
#endif

#define FACE_TRANSFORM_LIMIT 512u

#if FACE_TRANSFORM_SUPPORTED
static bool valid_surface(const face_raster_surface_t *s)
{
    return s && s->pixels && s->width && s->height &&
           s->width <= FACE_TRANSFORM_LIMIT && s->height <= FACE_TRANSFORM_LIMIT &&
           (uintptr_t)s->pixels % _Alignof(uint32_t) == 0 &&
           s->stride >= s->width && s->stride <= FACE_TRANSFORM_LIMIT &&
           (uint64_t)(s->height - 1) * s->stride + s->width <= s->capacity;
}
#endif

bool face_lvgl_rotate_region(const face_raster_surface_t *src, face_raster_surface_t *dst,
                             int32_t pivot_x, int32_t pivot_y, int32_t angle10,
                             int32_t origin_x, int32_t origin_y)
{
#if !FACE_TRANSFORM_SUPPORTED
    (void)src; (void)dst; (void)pivot_x; (void)pivot_y; (void)angle10; (void)origin_x; (void)origin_y;
    return false;
#else
    if (!valid_surface(src) || !valid_surface(dst) ||
        dst->stride != dst->width || pivot_x < 0 || pivot_y < 0 ||
        (uint32_t)pivot_x >= src->width || (uint32_t)pivot_y >= src->height || angle10 < -3599 || angle10 > 3599 ||
        origin_x < -512 || origin_x > 511 || origin_y < -512 || origin_y > 511)
        return false;
    uint64_t sn=((uint64_t)(src->height-1)*src->stride+src->width)*sizeof(uint32_t);
    uint64_t dn=(uint64_t)dst->width*dst->height*sizeof(uint32_t);
    uintptr_t sp=(uintptr_t)src->pixels, dp=(uintptr_t)dst->pixels;
    if (sn > UINTPTR_MAX-sp || dn > UINTPTR_MAX-dp || (sp < dp+dn && dp < sp+sn)) return false;
    if (!angle10) {
        int32_t left=origin_x < 0 ? 0 : origin_x;
        int32_t right=origin_x+(int32_t)dst->width;
        if (right > (int32_t)src->width) right=(int32_t)src->width;
        for (uint32_t y=0; y<dst->height; ++y) {
            uint32_t *row=dst->pixels+(size_t)y*dst->stride;
            int32_t sy=origin_y+(int32_t)y;
            memset(row,0,dst->width*sizeof(uint32_t));
            if (sy>=0 && sy<(int32_t)src->height && right>left)
                memcpy(row+(left-origin_x),src->pixels+(size_t)sy*src->stride+left,(size_t)(right-left)*sizeof(uint32_t));
        }
        return true;
    }
    lv_draw_image_dsc_t dsc;
    lv_draw_image_dsc_init(&dsc);
    dsc.scale_x=LV_SCALE_NONE; dsc.scale_y=LV_SCALE_NONE; dsc.antialias=1;
    dsc.rotation=angle10 < 0 ? angle10+3600 : angle10;
    dsc.pivot.x=pivot_x; dsc.pivot.y=pivot_y;
    lv_area_t area={origin_x,origin_y,origin_x+(int32_t)dst->width-1,origin_y+(int32_t)dst->height-1};
    lv_draw_sw_transform(&area,src->pixels,(int32_t)src->width,(int32_t)src->height,(int32_t)(src->stride*4),
                         &dsc,NULL,LV_COLOR_FORMAT_ARGB8888,dst->pixels);
    return true;
#endif
}

bool face_lvgl_rotate(const face_raster_surface_t *src, face_raster_surface_t *dst,
                      int32_t pivot_x, int32_t pivot_y, int32_t angle10)
{
    if (!src || !dst || src->width != dst->width || src->height != dst->height) return false;
    return face_lvgl_rotate_region(src,dst,pivot_x,pivot_y,angle10,0,0);
}
