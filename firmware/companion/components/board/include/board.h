#pragma once
#include "driver/i2c_master.h"
#include "esp_err.h"
#include "ui_events.h"

#ifdef __cplusplus
extern "C" {
#endif

/* I2C master bus, AXP2101 rails for the panel, panel reset and init. Call once from app_main. */
esp_err_t board_init(void);
i2c_master_bus_handle_t board_i2c_bus(void);

/* Starts the `ui` task (core 1, priority 6): LVGL init, display and buffers, then ui_setup() inside the
 * task, then lv_timer_handler() forever. Returns once ui_setup() has run (or on failure). */
esp_err_t lv_port_start(void (*ui_setup)(void));

/* Non-blocking enqueue (depth 16, event dropped when full) from any task; drained in the ui task. */
void lv_port_post(const ui_event_t *ev);
void lv_port_set_handler(void (*fn)(const ui_event_t *));

/* Rolling 5 s window: frames per second x10 and the longest single refresh in microseconds. */
void lv_port_frame_stats(uint32_t *fps_x10, uint32_t *worst_us);

#ifdef __cplusplus
}
#endif
