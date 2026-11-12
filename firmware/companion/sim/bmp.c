#include "bmp.h"
#include <stdio.h>
#include <stdlib.h>

static void put32(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i)); }

int bmp_write_rgb565(const char *path, const uint16_t *px, int w, int h)
{
    if (!path || !px || w <= 0 || h <= 0) return -1;
    uint32_t stride = ((uint32_t)w * 3 + 3) & ~3u; /* rows padded to 4 bytes */
    uint32_t data = stride * (uint32_t)h;
    uint8_t hdr[54] = {'B', 'M'};
    put32(hdr + 2, 54 + data);
    put32(hdr + 10, 54);          /* pixel data offset */
    put32(hdr + 14, 40);          /* BITMAPINFOHEADER */
    put32(hdr + 18, (uint32_t)w);
    put32(hdr + 22, (uint32_t)h); /* positive height = bottom-up */
    hdr[26] = 1;                  /* planes */
    hdr[28] = 24;                 /* bpp */
    put32(hdr + 34, data);

    uint8_t *row = calloc(1, stride);
    FILE *f = fopen(path, "wb");
    if (!row || !f) { free(row); if (f) fclose(f); return -1; }
    int ok = fwrite(hdr, 1, sizeof hdr, f) == sizeof hdr;
    for (int y = h - 1; ok && y >= 0; y--) {
        for (int x = 0; x < w; x++) {
            uint16_t c = px[y * w + x];
            uint8_t r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
            row[x * 3 + 0] = (uint8_t)((b << 3) | (b >> 2)); /* BMP is BGR */
            row[x * 3 + 1] = (uint8_t)((g << 2) | (g >> 4));
            row[x * 3 + 2] = (uint8_t)((r << 3) | (r >> 2));
        }
        ok = fwrite(row, 1, stride, f) == stride;
    }
    free(row);
    return (fclose(f) == 0 && ok) ? 0 : -1;
}
