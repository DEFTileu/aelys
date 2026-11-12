#pragma once
/* Headless LVGL display for host tests and screenshots: 466x466 RGB565 framebuffer, fake clock. */
#include <stdint.h>
#include "lvgl.h"

#define SIM_W 466
#define SIM_H 466

void sim_init(void);               /* lv_init + display + black screen; call once per process */
void sim_step(uint32_t ms);        /* advance the fake clock and render */
const uint16_t *sim_fb(void);      /* SIM_W*SIM_H RGB565 */
