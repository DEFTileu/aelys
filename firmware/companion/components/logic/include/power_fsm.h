#pragma once
/* Screen power state: ACTIVE -> DIM -> OFF on inactivity, OFF at once when face-down. Pure C, no IDF. */
#include <stdbool.h>
#include <stdint.h>

typedef enum { PWR_ACTIVE, PWR_DIM, PWR_OFF } pwr_state_t;
typedef enum {
    PWR_IN_TICK, PWR_IN_TOUCH, PWR_IN_BUTTON, PWR_IN_LIFT, PWR_IN_FACE_DOWN, PWR_IN_FACE_UP,
    PWR_IN_HOLD /* ui animating or combo held */
} pwr_in_t;
typedef struct { pwr_state_t state; bool face_down; uint32_t last_activity_ms, dim_ms, off_ms; } power_t;

void        power_init(power_t *p, uint32_t dim_ms, uint32_t off_ms, uint32_t now_ms);
/* Face-down: TOUCH and HOLD (a notification animating) never wake; BUTTON, LIFT and FACE_UP do. */
pwr_state_t power_update(power_t *p, pwr_in_t in, uint32_t now_ms);
