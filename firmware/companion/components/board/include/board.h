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

/* Panel brightness, 5..100 % (clamped) -> CO5300 register 0x51 = 13..255. Not thread-safe against the ui task's flushes
 * (one SPI device): call it at boot before lv_port_start, then only from the ui task (post UI_EV_BRIGHTNESS).
 * ESP_ERR_INVALID_STATE before board_init(). */
esp_err_t board_display_set_brightness(uint8_t pct);

/* Battery state of charge (0..100) and whether it is charging, from the AXP2101 fuel gauge. False when there is no
 * battery or the PMIC does not answer; the outputs are then untouched. Safe from any task. */
bool board_battery(uint8_t *pct, bool *charging);

/* Starts the `ui` task (core 1, priority 6): LVGL init, display and buffers, then ui_setup() inside the
 * task, then lv_timer_handler() forever. Returns once ui_setup() has run (or on failure). */
esp_err_t lv_port_start(void (*ui_setup)(void));

/* Non-blocking enqueue (depth 16) from any task; drained in the ui task. False when the queue is full
 * (event dropped) or the port is not started. */
bool lv_port_post(const ui_event_t *ev);
void lv_port_set_handler(void (*fn)(const ui_event_t *));

/* esp_timer microseconds (low 32 bits) when the last refresh that drew something finished. */
uint32_t lv_port_last_flush_end_us(void);

/* Same clock, for the first refresh that drew something after boot (0 until then): boot_ms. */
uint32_t lv_port_first_flush_end_us(void);

/* Touch (CST9217), BOOT key and the AXP2101 PWR key, polled every 10 ms in the `input` task. Posts
 * UI_EV_TOUCH (data = x, y as two uint16, little-endian), UI_EV_COMBO_PROGRESS (percent, 0 on
 * release) and UI_EV_COMBO_FIRE (BOOT + PWR held 2 s). Also
 * UI_EV_TAP / UI_EV_SWIPE_LEFT / UI_EV_SWIPE_RIGHT at the lift (gesture.h), UI_EV_RELEASE after them, and UI_EV_BTN
 * (BTN_TOP / BTN_LOW) for a short click of one key. Call after board_init(). Returns the first
 * init error but starts the task anyway with whatever worked. */
esp_err_t board_input_start(void);

/* QMI8658 accelerometer (probes 0x6B then 0x6A). ESP_ERR_NOT_FOUND when absent: then reads return false.
 * Raw axes in the chip frame, +-2 g full scale; mapping to screen axes is the caller's (level.h). */
esp_err_t board_imu_init(void);
bool board_imu_read(int16_t *ax, int16_t *ay, int16_t *az);

/* "Find Aelys": plays the 2 kHz beep pattern (200 ms on / 200 ms off, beep.h) through the ES8311 and the speaker for duration_ms, at most 60 s.
 * Returns at once: an `audio` task (priority 3) is created for it and deleted when the sound ends; the codec, the I2S channel and the amplifier
 * exist only while it plays, so nothing is held at idle. On success it posts UI_EV_FIND data[0] = 1 (the overlay); when the sound ends for any
 * reason (time, board_audio_stop, an init error in the task) the task posts data[0] = 0. Both are posted under one lock, so a request that
 * arrives while the previous sound is torn down still gets FIND(0) then FIND(1), in that order. Called while it plays, it restarts the clock
 * (the sound goes on for another duration_ms). Call it from ONE task (the link task): it may wait a few tens of ms for the teardown.
 * ESP_ERR_NO_MEM when the task cannot be created (nothing posted); ESP_ERR_INVALID_ARG for 0. A failure to start the codec or I2S cannot be
 * known here: it ends the sound at once with FIND(0). */
esp_err_t board_audio_beep(uint32_t duration_ms);
/* Ends the sound within about 10 ms. Non-blocking, safe from any task (the ui task calls it on a tap) while the audio task runs; a no-op when
 * nothing plays. */
void board_audio_stop(void);
/* Call once at boot, before the tasks that use the two calls above and below start. */
void board_audio_init(void);
/* A short sound effect (sfx.h id), from the ui task. Never waits: dropped while "find me" beeps or while a sound is being torn down;
 * a new one replaces the one playing. Shares the find beeps' audio task, codec and amplifier, which exist only while it plays. */
void board_audio_sfx(uint8_t id);

/* Rolling 5 s window: frames per second x10 and the longest single refresh in microseconds. */
void lv_port_frame_stats(uint32_t *fps_x10, uint32_t *worst_us);
/* Frames drawn and the longest one since the previous call, then resets both (the metrics task's per-second line). */
void lv_port_frame_take(uint32_t *frames, uint32_t *worst_us);

#ifdef CONFIG_AELYS_PERF_PROBE
#include "perf_probe.h"
#define BOARD_UI_EV_PERF 254u /* internal bench request; never forwarded to ui_handle_event */
typedef perf_probe_stats_t lv_port_probe_t;
/* Call in UI setup. Both callbacks run only in the UI task. */
void lv_port_probe_set_ui(bool (*swipe)(void), uint32_t (*screen)(void));
/* One metrics reader: gets a coherent cumulative snapshot, or false if no new publish. */
bool lv_port_probe_read(lv_port_probe_t *out);
/* Physical input and queued real gestures take precedence, even if TOUCH could not be enqueued. */
bool board_probe_input_busy(void);
#endif

#ifdef __cplusplus
}
#endif
