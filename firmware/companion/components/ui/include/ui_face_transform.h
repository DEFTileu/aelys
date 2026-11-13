#pragma once
/* Experimental LVGL 9.6 software rotation; not connected to the face UI. */
#include <stdbool.h>
#include <stdint.h>
#include "face_raster.h"

/* Straight-alpha ARGB8888 surfaces must be disjoint and equally sized. The
 * destination is tightly packed; dimensions and source stride are at most
 * 512 pixels. Angle is in tenths of a degree, -3599..3599; pivot is inside
 * the source. Unsupported LVGL versions/configurations and invalid input
 * return false and leave the destination unchanged. Output is clipped to
 * the original rectangle; use the region variant for an expanded output. */
bool face_lvgl_rotate(const face_raster_surface_t *src, face_raster_surface_t *dst,
                      int32_t pivot_x, int32_t pivot_y, int32_t angle10);

/* Render an explicitly chosen output rectangle. Its top-left is (origin_x,
 * origin_y) in source coordinates; destination dimensions may differ from
 * the source, allowing caller-provided padding for transformed pixels. Origins
 * are limited to -512..511 in each axis. */
bool face_lvgl_rotate_region(const face_raster_surface_t *src, face_raster_surface_t *dst,
                             int32_t pivot_x, int32_t pivot_y, int32_t angle10,
                             int32_t origin_x, int32_t origin_y);
