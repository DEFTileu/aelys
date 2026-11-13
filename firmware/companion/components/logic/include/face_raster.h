#pragma once
/* Experimental allocation-free ARGB8888 eye primitives; not yet connected to
 * the UI. Caller owns the surface. Rotation and end-to-end fidelity are pending. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint32_t *pixels;
    uint32_t width, height, stride; /* stride and capacity are in pixels */
    size_t capacity;
} face_raster_surface_t;

typedef enum { FACE_RASTER_LID_NONE, FACE_RASTER_LID_SLANT, FACE_RASTER_LID_DOME } face_raster_lid_t;
typedef enum { FACE_RASTER_PILL, FACE_RASTER_RING } face_raster_kind_t;
typedef struct {
    int32_t x, y, width, height, radius;
    uint32_t top_rgb, bottom_rgb;
    face_raster_kind_t kind;
    face_raster_lid_t lid;
    int32_t dome_cx, dome_cy, dome_rx, dome_ry; /* absolute ellipse coordinates */
    int32_t border, ring_cos, ring_sin; /* ring width, opening direction (Q15) */
    int32_t lid_y10, lid_slope; /* cut from top, tenths of px; slope permille */
    int32_t star_x, star_y;
    uint32_t star_w, star_h, star_stride;
    size_t star_size;
    const uint8_t *star_data; /* A8 coverage; no allocation or ownership transfer */
    uint8_t star_opacity;
} face_raster_eye_t;

/* Composites the eye, highlight and opaque lid in order, clipping every write.
 * Clear the caller-owned surface before a new frame. False leaves it untouched. */
bool face_raster_eye(face_raster_surface_t *surface, const face_raster_eye_t *eye);

/* Rotate between disjoint, equally sized caller-owned surfaces around an
 * integer pixel pivot. cos/sin are Q15. Transparent edges are interpolated in
 * premultiplied space, then stored as straight-alpha ARGB8888. No allocation. */
bool face_raster_rotate(const face_raster_surface_t *src, face_raster_surface_t *dst,
                        int32_t pivot_x, int32_t pivot_y, int32_t cos_q15, int32_t sin_q15);
