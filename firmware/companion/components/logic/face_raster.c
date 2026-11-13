#include "face_raster.h"
#include <limits.h>

#define RASTER_LIMIT 4096

static bool inside(const face_raster_eye_t *e, int64_t x4, int64_t y4, int32_t radius)
{
    int64_t w4 = (int64_t)e->width * 4, h4 = (int64_t)e->height * 4, r4 = (int64_t)radius * 4;
    if (e->kind == FACE_RASTER_RING) {
        int64_t dx = x4 - w4 / 2, dy = y4 - h4 / 2;
        int64_t outer = w4 / 2, inner = outer - (int64_t)e->border * 4;
        int64_t distance = dx * dx + dy * dy;
        int64_t dot = dx * e->ring_cos + dy * e->ring_sin;
        int64_t cross = -dx * e->ring_sin + dy * e->ring_cos;
        if (cross < 0) cross = -cross;
        return distance <= outer * outer && distance >= inner * inner && !(dot > 0 && cross < dot);
    }
    if (!radius) return true;
    int64_t dx = x4 < r4 ? x4-r4 : x4 > w4-r4 ? x4-(w4-r4) : 0;
    int64_t dy = y4 < r4 ? y4-r4 : y4 > h4-r4 ? y4-(h4-r4) : 0;
    return dx*dx + dy*dy <= r4*r4;
}

static unsigned gradient(unsigned a, unsigned b, int32_t y, int32_t height)
{
    return height <= 1 ? a : (a * (unsigned)(height-1-y) + b * (unsigned)y + (unsigned)(height-1)/2) / (unsigned)(height-1);
}

/* Straight-alpha source over destination, rounded in integer arithmetic. */
static uint32_t over(uint32_t dst, uint32_t rgb, unsigned alpha)
{
    if (!alpha) return dst;
    if (alpha >= 255) return 0xff000000u | (rgb & 0xffffffu);
    unsigned da = dst >> 24;
    unsigned alpha_num = alpha * 255u + da * (255-alpha);
    if (!alpha_num) return 0;
    unsigned out_a = (alpha_num + 127u) / 255u;
    uint32_t out = out_a << 24;
    for (int shift = 0; shift <= 16; shift += 8) {
        unsigned sc = (rgb >> shift) & 255, dc = (dst >> shift) & 255;
        unsigned value = (sc * alpha * 255u + dc * da * (255-alpha) + alpha_num/2u) / alpha_num;
        if (value > 255) value = 255;
        out |= value << shift;
    }
    return out;
}

static bool eye_valid(const face_raster_eye_t *e, unsigned parts)
{
    if (!parts || (parts & ~FACE_RASTER_ALL) || !e ||
        e->width <= 0 || e->height <= 0 || e->width > RASTER_LIMIT || e->height > RASTER_LIMIT || e->radius < 0 ||
        (e->kind != FACE_RASTER_PILL && e->kind != FACE_RASTER_RING) ||
        (e->lid != FACE_RASTER_LID_NONE && e->lid != FACE_RASTER_LID_SLANT && e->lid != FACE_RASTER_LID_DOME) ||
        e->lid_y10 < -RASTER_LIMIT || e->lid_y10 > RASTER_LIMIT ||
        e->lid_slope < -RASTER_LIMIT || e->lid_slope > RASTER_LIMIT) return false;
    if (e->lid == FACE_RASTER_LID_DOME && (e->dome_rx <= 0 || e->dome_ry <= 0 ||
        e->dome_rx > RASTER_LIMIT || e->dome_ry > RASTER_LIMIT)) return false;
    if (e->lid_bounds_set && (e->lid != FACE_RASTER_LID_SLANT || e->lid_width <= 0 || e->lid_height <= 0 ||
        e->lid_width > RASTER_LIMIT || e->lid_height > RASTER_LIMIT)) return false;
    if (e->kind == FACE_RASTER_RING && (e->border <= 0 || e->border > e->width/2 ||
        e->ring_cos < -32768 || e->ring_cos > 32768 || e->ring_sin < -32768 || e->ring_sin > 32768 ||
        (!e->ring_cos && !e->ring_sin))) return false;
    if ((e->star_w || e->star_h) && (!e->star_data || !e->star_w || !e->star_h || e->star_stride < e->star_w ||
        e->star_w > RASTER_LIMIT || e->star_h > RASTER_LIMIT ||
        (uint64_t)(e->star_h-1)*e->star_stride+e->star_w > e->star_size)) return false;
    return true;
}

static face_raster_bounds_t mask_bounds(const face_raster_eye_t *e)
{
    face_raster_bounds_t b;
    if (e->lid == FACE_RASTER_LID_DOME) {
        b.left=(int64_t)e->dome_cx-e->dome_rx; b.right=(int64_t)e->dome_cx+e->dome_rx;
        b.top=(int64_t)e->dome_cy-e->dome_ry; b.bottom=(int64_t)e->dome_cy+e->dome_ry;
    } else if (e->lid_bounds_set) {
        b.left=e->lid_x; b.right=b.left+e->lid_width;
        b.top=e->lid_y; b.bottom=b.top+e->lid_height;
    } else {
        b.left=(int64_t)e->x-2; b.right=(int64_t)e->x+e->width+2;
        b.top=(int64_t)e->y-6;
        int64_t spread=(int64_t)(e->lid_slope < 0 ? -e->lid_slope : e->lid_slope)*(e->width+4)/2000;
        b.bottom=(int64_t)e->y+e->lid_y10/10+spread+2;
    }
    return b;
}

static void union_bounds(face_raster_bounds_t *out, bool *has_bounds, face_raster_bounds_t b)
{
    if (b.left>=b.right || b.top>=b.bottom) return;
    if (!*has_bounds) { *out=b; *has_bounds=true; return; }
    if (b.left<out->left) out->left=b.left;
    if (b.top<out->top) out->top=b.top;
    if (b.right>out->right) out->right=b.right;
    if (b.bottom>out->bottom) out->bottom=b.bottom;
}

bool face_raster_eye_bounds(const face_raster_eye_t *e, unsigned parts, face_raster_bounds_t *out)
{
    if (!out || !eye_valid(e,parts)) return false;
    face_raster_bounds_t result={0,0,0,0}; bool has_bounds=false;
    if (parts & FACE_RASTER_BODY) {
        face_raster_bounds_t b={e->x,e->y,(int64_t)e->x+e->width,(int64_t)e->y+e->height};
        union_bounds(&result,&has_bounds,b);
    }
    if ((parts & FACE_RASTER_HIGHLIGHT) && e->star_data && e->star_w && e->star_h) {
        int64_t left=(int64_t)e->x+e->star_x, top=(int64_t)e->y+e->star_y;
        face_raster_bounds_t b={left,top,left+e->star_w,top+e->star_h};
        union_bounds(&result,&has_bounds,b);
    }
    if ((parts & FACE_RASTER_MASK) && e->lid != FACE_RASTER_LID_NONE)
        union_bounds(&result,&has_bounds,mask_bounds(e));
    *out=result;
    return true;
}

bool face_raster_eye_parts(face_raster_surface_t *s, const face_raster_eye_t *e, unsigned parts)
{
    if (!s || !s->pixels || !s->width || !s->height || s->width > RASTER_LIMIT || s->height > RASTER_LIMIT ||
        s->stride < s->width || (uint64_t)(s->height-1)*s->stride+s->width > s->capacity || !eye_valid(e,parts)) return false;
    if (parts & FACE_RASTER_BODY) {
        int32_t radius = e->radius;
        if (radius > e->width/2) radius = e->width/2;
        if (radius > e->height/2) radius = e->height/2;
        int64_t x0=e->x, y0=e->y, x1=x0+e->width, y1=y0+e->height;
        if (x0 < 0) x0=0;
        if (y0 < 0) y0=0;
        if (x1 > s->width) x1=s->width;
        if (y1 > s->height) y1=s->height;
        for (int64_t y=y0; y<y1; ++y) for (int64_t x=x0; x<x1; ++x) {
            int64_t px=x-e->x, py=y-e->y;
            unsigned cover=0;
            for (int j=1; j<=3; j+=2) for (int i=1; i<=3; i+=2)
                cover += inside(e,px*4+i,py*4+j,radius);
            if (!cover) continue;
            unsigned r=gradient((e->top_rgb>>16)&255,(e->bottom_rgb>>16)&255,(int32_t)py,e->height);
            unsigned g=gradient((e->top_rgb>>8)&255,(e->bottom_rgb>>8)&255,(int32_t)py,e->height);
            unsigned b=gradient(e->top_rgb&255,e->bottom_rgb&255,(int32_t)py,e->height);
            size_t index=(size_t)y*s->stride+(size_t)x;
            s->pixels[index]=over(s->pixels[index],(r<<16)|(g<<8)|b,(cover*255u+2)/4);
        }
    }
    if ((parts & FACE_RASTER_HIGHLIGHT) && e->star_data && e->star_w && e->star_h) {
        int64_t left=(int64_t)e->x+e->star_x, top=(int64_t)e->y+e->star_y;
        int64_t xa=left < 0 ? 0 : left, ya=top < 0 ? 0 : top;
        int64_t xb=left+e->star_w, yb=top+e->star_h;
        if (xb > s->width) xb=s->width;
        if (yb > s->height) yb=s->height;
        for (int64_t y=ya; y<yb; ++y) for (int64_t x=xa; x<xb; ++x) {
            size_t si=(size_t)(y-top)*e->star_stride+(size_t)(x-left);
            size_t di=(size_t)y*s->stride+(size_t)x;
            unsigned alpha=(e->star_data[si]*e->star_opacity+127)/255;
            s->pixels[di]=over(s->pixels[di],0xffffffu,alpha);
        }
    }
    if ((parts & FACE_RASTER_MASK) && e->lid != FACE_RASTER_LID_NONE) {
        face_raster_bounds_t bounds=mask_bounds(e);
        int64_t left=bounds.left, top=bounds.top, right=bounds.right, bottom=bounds.bottom;
        if (left<0) left=0;
        if (top<0) top=0;
        if (right>s->width) right=s->width;
        if (bottom>s->height) bottom=s->height;
        for (int64_t y=top; y<bottom; ++y) for (int64_t x=left; x<right; ++x) {
            unsigned cover=0;
            for (int j=1;j<=3;j+=2) for (int i=1;i<=3;i+=2) {
                int64_t px=x*4+i, py=y*4+j;
                if (e->lid == FACE_RASTER_LID_DOME) {
                    int64_t dx=px-(int64_t)e->dome_cx*4, dy=py-(int64_t)e->dome_cy*4;
                    int64_t rx=(int64_t)e->dome_rx*4, ry=(int64_t)e->dome_ry*4;
                    if (dx>=-rx && dx<=rx && dy>=-ry && dy<=ry &&
                        dx*dx*ry*ry+dy*dy*rx*rx <= rx*rx*ry*ry) cover++;
                } else {
                    int64_t rx=px-(int64_t)e->x*4, ry=py-(int64_t)e->y*4;
                    if (ry*1000 < (int64_t)e->lid_y10*400 + (int64_t)e->lid_slope*(rx-(int64_t)e->width*2)) cover++;
                }
            }
            size_t index=(size_t)y*s->stride+(size_t)x;
            s->pixels[index]=over(s->pixels[index],0,(cover*255u+2)/4);
        }
    }
    return true;
}

bool face_raster_eye(face_raster_surface_t *s, const face_raster_eye_t *e)
{
    return face_raster_eye_parts(s, e, FACE_RASTER_ALL);
}

static bool surface_valid(const face_raster_surface_t *s)
{
    return s && s->pixels && s->width && s->height && s->width <= RASTER_LIMIT && s->height <= RASTER_LIMIT &&
           s->stride >= s->width && (uint64_t)(s->height-1)*s->stride+s->width <= s->capacity;
}

bool face_raster_rotate(const face_raster_surface_t *src, face_raster_surface_t *dst,
                        int32_t pivot_x, int32_t pivot_y, int32_t cos_q15, int32_t sin_q15)
{
    if (!surface_valid(src) || !surface_valid(dst) || src->width != dst->width || src->height != dst->height ||
        pivot_x < -RASTER_LIMIT || pivot_x > RASTER_LIMIT*2 || pivot_y < -RASTER_LIMIT || pivot_y > RASTER_LIMIT*2 ||
        cos_q15 < -32768 || cos_q15 > 32768 || sin_q15 < -32768 || sin_q15 > 32768 || (!cos_q15 && !sin_q15)) return false;
    uint64_t sn=((uint64_t)(src->height-1)*src->stride+src->width)*sizeof(uint32_t);
    uint64_t dn=((uint64_t)(dst->height-1)*dst->stride+dst->width)*sizeof(uint32_t);
    uintptr_t sp=(uintptr_t)src->pixels, dp=(uintptr_t)dst->pixels;
    if (sn > UINTPTR_MAX-sp || dn > UINTPTR_MAX-dp || (sp < dp+dn && dp < sp+sn)) return false;
    for (uint32_t y=0; y<dst->height; ++y) for (uint32_t x=0; x<dst->width; ++x) {
        int64_t dx=(int64_t)x-pivot_x, dy=(int64_t)y-pivot_y;
        int64_t sx=(int64_t)pivot_x*256 + (dx*256*cos_q15 + dy*256*sin_q15)/32768;
        int64_t sy=(int64_t)pivot_y*256 + (-dx*256*sin_q15 + dy*256*cos_q15)/32768;
        int64_t ix=sx/256, iy=sy/256, fx=sx%256, fy=sy%256;
        if (fx<0) { fx+=256; ix--; }
        if (fy<0) { fy+=256; iy--; }
        uint64_t alpha=0, red=0, green=0, blue=0;
        for (int j=0;j<2;++j) for (int i=0;i<2;++i) {
            int64_t px=ix+i, py=iy+j;
            if (px<0 || py<0 || px>=src->width || py>=src->height) continue;
            uint32_t color=src->pixels[(size_t)py*src->stride+(size_t)px];
            uint64_t weight=(uint64_t)(i ? fx : 256-fx)*(uint64_t)(j ? fy : 256-fy);
            uint64_t a=(color>>24)*weight;
            alpha+=a; red+=((color>>16)&255u)*a; green+=((color>>8)&255u)*a; blue+=(color&255u)*a;
        }
        uint32_t out=0;
        if (alpha) {
            uint32_t a=(uint32_t)((alpha+32768)/65536);
            if (a) out=(a<<24)|((uint32_t)((red+alpha/2)/alpha)<<16)|
                       ((uint32_t)((green+alpha/2)/alpha)<<8)|(uint32_t)((blue+alpha/2)/alpha);
        }
        dst->pixels[(size_t)y*dst->stride+x]=out;
    }
    return true;
}
