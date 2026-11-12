#pragma once
#include "driver/i2c_master.h"
#include <stdbool.h>
#include <stdint.h>
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

/* Non-blocking enqueue (depth 16) from any task; drained in the ui task. False when the queue is full
 * (event dropped) or the port is not started. */
bool lv_port_post(const ui_event_t *ev);
void lv_port_set_handler(void (*fn)(const ui_event_t *));

/* esp_timer microseconds (low 32 bits) when the last refresh that drew something finished. */
uint32_t lv_port_last_flush_end_us(void);

/* Touch (CST9217), BOOT key and the AXP2101 PWR key, polled every 10 ms in the `input` task. Posts
 * UI_EV_TOUCH (data = x, y as two uint16, little-endian), UI_EV_COMBO_PROGRESS (percent, 0 on
 * release) and UI_EV_COMBO_FIRE (BOOT + PWR held 2 s). Call after board_init(). Returns the first
 * init error but starts the task anyway with whatever worked. */
esp_err_t board_input_start(void);

/* Rolling 5 s window: frames per second x10 and the longest single refresh in microseconds. */
void lv_port_frame_stats(uint32_t *fps_x10, uint32_t *worst_us);

#ifdef __cplusplus
}
#endif
