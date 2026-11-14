#include "ui_face_transform.h"
#include <limits.h>
#include <stdint.h>
#include <string.h>
#include "lvgl.h"
#if LVGL_VERSION_MAJOR == 9 && LVGL_VERSION_MINOR == 6 && LVGL_VERSION_PATCH == 0 && \
    LV_USE_DRAW_SW && LV_DRAW_SW_SUPPORT_ARGB8888 && !LV_DRAW_SW_SUPPORT_ARGB8888_PREMULTIPLIED && \
    LV_TRIGO_SHIFT == 15 && ((-1 >> 1) == -1)
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

/* LVGL's inverse sampler uses separately rounded Q8 terms. Bounds below use
 * floor/ceiling division rather than relying on signed right-shift semantics. */
#if FACE_TRANSFORM_SUPPORTED
static int64_t floor_div(int64_t n, int64_t d) { return n/d - (n%d < 0); }
static int64_t ceil_div(int64_t n, int64_t d) { return n/d + (n%d > 0); }
static int64_t minprod(int64_t k, int64_t lo, int64_t hi) { return k < 0 ? k*hi : k*lo; }
static int64_t maxprod(int64_t k, int64_t lo, int64_t hi) { return k < 0 ? k*lo : k*hi; }
#endif

bool face_lvgl_rotation_bounds(uint32_t width, uint32_t height, int32_t pivot_x, int32_t pivot_y,
                               int32_t angle10, face_raster_bounds_t *out)
{
#if !FACE_TRANSFORM_SUPPORTED
    (void)width; (void)height; (void)pivot_x; (void)pivot_y; (void)angle10; (void)out;
    return false;
#else
    if (!out || !width || !height || width > FACE_TRANSFORM_LIMIT || height > FACE_TRANSFORM_LIMIT ||
        pivot_x < 0 || pivot_y < 0 || (uint32_t)pivot_x >= width || (uint32_t)pivot_y >= height ||
        angle10 < -3599 || angle10 > 3599) return false;
    if (!angle10) { *out=(face_raster_bounds_t){0,0,width,height}; return true; }
    int32_t rotation=angle10<0 ? angle10+3600 : angle10;
    int32_t a=-rotation, lo=a/10, rem=a-10*lo;
    int64_t sv=((int64_t)lv_trigo_sin((int16_t)lo)*(10-rem) + (int64_t)lv_trigo_sin((int16_t)(lo+1))*rem)/10;
    int64_t cv=((int64_t)lv_trigo_sin((int16_t)(lo+90))*(10-rem) + (int64_t)lv_trigo_sin((int16_t)(lo+91))*rem)/10;
    int64_t s=floor_div(sv,32), c=floor_div(cv,32), determinant=c*c+s*s;
    if (!determinant) return false;
    /* Pinned LVGL computes U=x0+floor(c*x/4)+floor(-s*y/4),
     * V=y0+floor(s*x/4)+floor(c*y/4). A visible sample has
     * 0<=U<256*width, 0<=V<256*height. Each separately floored term
     * contributes a remainder in 0..3, hence +6 below. Invert the
     * coefficient matrix and round outward to bound integer output pixels. */
    int64_t x0=(-c*pivot_x+s*pivot_y)/4 + (int64_t)pivot_x*256 + 128;
    int64_t y0=(-s*pivot_x-c*pivot_y)/4 + (int64_t)pivot_y*256 + 128;
    int64_t alo=-4*x0, ahi=4*((int64_t)256*width-1-x0)+6;
    int64_t blo=-4*y0, bhi=4*((int64_t)256*height-1-y0)+6;
    face_raster_bounds_t b={
        ceil_div(minprod(c,alo,ahi)+minprod(s,blo,bhi),determinant),
        ceil_div(minprod(-s,alo,ahi)+minprod(c,blo,bhi),determinant),
        floor_div(maxprod(c,alo,ahi)+maxprod(s,blo,bhi),determinant)+1,
        floor_div(maxprod(-s,alo,ahi)+maxprod(c,blo,bhi),determinant)+1
    };
    *out=b;
    return true;
#endif
}

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
