#pragma once
#include <stdint.h>

/* Writes a 24-bit uncompressed BMP (bottom-up rows) from an RGB565 buffer. Returns 0 on success. */
int bmp_write_rgb565(const char *path, const uint16_t *px, int w, int h);
