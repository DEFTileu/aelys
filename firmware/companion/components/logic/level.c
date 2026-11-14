#include "level.h"
#include <math.h>
#include <stdlib.h>

#define FLAT_RATIO 0.35f /* in-plane gravity below 35 % of the total: lying flat, keep the angle */
#define SMOOTH     0.25f /* low-pass step per sample */
#define DEADBAND10 20    /* ignore changes under 2 degrees: no shimmer when held still */

static int32_t wrap10(int32_t a)
{
    while (a > 1800) a -= 3600;
    while (a <= -1800) a += 3600;
    return a;
}

int32_t level_update(level_t *l, int32_t gx, int32_t gy)
{
    float plane = sqrtf((float)gx * gx + (float)gy * gy);
    if (plane < 1.0f) return l->angle10;
    /* Upright board: gravity points down the screen (+y), angle 0. Tilted right: gravity gains +x. */
    int32_t target = wrap10((int32_t)lroundf(atan2f((float)gx, (float)gy) * 1800.0f / (float)M_PI));
    if (!l->valid) {
        l->angle10 = target;
        l->valid = true;
        return target;
    }
    int32_t diff = wrap10(target - l->angle10);
    if (abs(diff) < DEADBAND10) return l->angle10;
    l->angle10 = wrap10(l->angle10 + (int32_t)lroundf(diff * SMOOTH));
    return l->angle10;
}

int32_t level_update_3d(level_t *l, int32_t gx, int32_t gy, int32_t gz)
{
    float total = sqrtf((float)gx * gx + (float)gy * gy + (float)gz * gz);
    float plane = sqrtf((float)gx * gx + (float)gy * gy);
    if (total < 1.0f || plane < FLAT_RATIO * total) return l->angle10;
    return level_update(l, gx, gy);
}
