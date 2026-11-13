#pragma once
/* Headless LVGL display for host tests and screenshots: 466x466 RGB565 framebuffer, fake clock. */
#include <stdint.h>
#include "lvgl.h"

#define SIM_W 466
#define SIM_H 466

void sim_init(void);               /* lv_init + display + black screen; call once per process */
void sim_direct(void);             /* redraw only invalidated areas (DIRECT render mode), like the board's partial refresh */
void sim_step(uint32_t ms);        /* advance the fake clock and render */
const uint16_t *sim_fb(void);      /* SIM_W*SIM_H RGB565 */

/* Deliver one UI event to ui_handle_event() (the UI must have been set up with ui_setup()). */
void sim_post(uint8_t type, const void *data, uint8_t len);

/* Refreshes that drew something since sim_init(): a screen with nothing animating must not add to it. */
uint32_t sim_flushes(void);
