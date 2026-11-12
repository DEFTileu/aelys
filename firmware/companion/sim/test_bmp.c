#include <stdio.h>
#include "bmp.h"
#include "check.h"

int main(void)
{
    /* 3x2, RGB565: top row red, green, blue; bottom row white, black, F4F1FF-ish */
    const uint16_t px[6] = {0xF800, 0x07E0, 0x001F, 0xFFFF, 0x0000, 0xF7BF};
    const char *path = "test_bmp_out.bmp";
    CHECK_EQ(bmp_write_rgb565(path, px, 3, 2), 0);
    CHECK(bmp_write_rgb565(NULL, px, 3, 2) != 0);
    CHECK(bmp_write_rgb565(path, px, 0, 2) != 0);

    unsigned char f[128] = {0};
    FILE *fp = fopen(path, "rb");
    size_t n = fp ? fread(f, 1, sizeof f, fp) : 0;
    if (fp) fclose(fp);
    CHECK_EQ(n, 54 + 2 * 12);              /* row = 9 bytes padded to 12 */
    CHECK(f[0] == 'B' && f[1] == 'M');
    CHECK_EQ(f[18], 3); CHECK_EQ(f[22], 2); CHECK_EQ(f[28], 24);
    /* bottom-up: first stored row is the image's bottom row; pixel 0 = white (BGR) */
    CHECK(f[54] == 255 && f[55] == 255 && f[56] == 255);
    CHECK(f[57] == 0 && f[58] == 0 && f[59] == 0);
    /* second stored row = top row: red -> BGR 00 00 FF, blue -> FF 00 00 */
    CHECK(f[66] == 0 && f[67] == 0 && f[68] == 255);
    CHECK(f[72] == 255 && f[73] == 0 && f[74] == 0);
    remove(path);
    return g_failed ? 1 : 0;
}
