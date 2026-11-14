#pragma once
/* "Always level": the angle to counter-rotate the eyes by so they stay level however the board is turned.
 * Pure C, no IMU access: feed it gravity already mapped to screen axes (x right, y down), any unit. */
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    int32_t angle10; /* current eye rotation, tenths of a degree, -1799..1800 */
    bool valid;      /* false until the first usable sample */
} level_t;

/* Returns the new eye rotation from in-plane gravity, smoothed, with a 2 degree deadband. */
int32_t level_update(level_t *l, int32_t gx, int32_t gy);

/* Same, from a full 3-axis sample (z out of the screen); a board lying flat keeps the last angle. */
int32_t level_update_3d(level_t *l, int32_t gx, int32_t gy, int32_t gz);
