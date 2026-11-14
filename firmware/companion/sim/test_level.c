/* "Always level" eye rotation from gravity. */
#include "check.h"
#include "level.h"

int main(void)
{
    level_t l = {0};
    CHECK_EQ(level_update(&l, 0, 1000), 0);              /* upright */
    level_t r = {0};
    CHECK_EQ(level_update(&r, 1000, 0), 900);            /* turned 90 degrees */
    level_t u = {0};
    CHECK_EQ(level_update(&u, 0, -1000), 1800);          /* upside down */

    level_t s = {0};
    level_update(&s, 0, 1000);
    CHECK_EQ(level_update(&s, 17, 1000), 0);             /* ~1 degree: deadband, no shimmer */
    int32_t a = level_update(&s, 1000, 0);               /* jump to 90: smoothed, not instant */
    CHECK(a > 0 && a < 900);
    for (int i = 0; i < 40; i++) a = level_update(&s, 1000, 0);
    CHECK(a > 880 && a <= 900);                          /* settles within the deadband */

    level_t w = {0};                                     /* wraps the short way across 180 */
    level_update(&w, -50, -1000);                        /* ~ +177 */
    a = level_update(&w, 50, -1000);                     /* ~ -177: step across 180, not back through 0 */
    CHECK(a > 1700 || a < -1700);

    level_t f = {0};
    level_update_3d(&f, 0, 1000, 0);
    CHECK_EQ(level_update_3d(&f, 1000, 50, 4000), 0);    /* lying flat: keep the angle */
    CHECK_EQ(level_update(&f, 0, 0), 0);                 /* no gravity: keep */
    return g_failed ? 1 : 0;
}
