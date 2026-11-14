/* Input glue: CST9217 touch, the BOOT key (GPIO0, active low) and the AXP2101 PWR key.
 * The touch controller is read over I2C only when its INT line is low (or a falling edge latched it).
 * The PWR key reaches the SoC only through the PMIC, so it is read as PKEY press/release edge
 * interrupts, polled and cleared over I2C every 20 ms (the PMIC IRQ line is not wired).
 * BOOT + PWR held COMBO_HOLD_MS opens the ICE card; the PMIC's own long-press power-off is pushed
 * out to 10 s so the 2 s hold can never power the board off. */
#include <stdint.h>
#include <string.h>

#include "board.h"
#include "board_pins.h"
#include "combo.h"
#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch_cst9217.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "gesture.h"
#include "level.h"
#include "pwrkey.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "input";

/* shortcut: top/low key mapping unverified on hardware. Assumed: the PWR key (AXP2101) is the top side key and BOOT the
 * lower one. If the board says otherwise, swap the two arguments of btn_feed() below (the board step of Task F8). */

#define POLL_MS     4 /* loop period: INT level, BOOT key, combo */
#define SLOW_PASSES 5 /* every 20 ms: PMIC edges, and the release check while a finger is down */
#define IMU_PASSES  25 /* every 100 ms: accelerometer for the level face */
/* Chip axes to screen axes (x right, y down). shortcut: set from one upright sample; recheck if the face turns the wrong way. */
#define IMU_SCREEN_X(ax, ay) (ax)
#define IMU_SCREEN_Y(ax, ay) (ay)

/* AXP2101 registers (datasheet / XPowersLib) */
#define AXP_PWRKEY_TIMES 0x27 /* [5:4] IRQ time, [3:2] power-on time, [1:0] power-off time: 4/6/8/10 s */
#define AXP_IRQ_EN1      0x41 /* bit0 PKEY positive edge (release), bit1 PKEY negative edge (press) */
#define AXP_IRQ_STS1     0x49 /* same bits, latched, write 1 to clear */
#define AXP_PKEY_POS     (1u << 0)
#define AXP_PKEY_NEG     (1u << 1)
#define AXP_OFF_10S      0x03

static i2c_master_dev_handle_t axp;
static esp_lcd_touch_handle_t touch;
static volatile bool touch_irq; /* INT fell since the last read: a pulse shorter than a poll still counts */

#ifdef CONFIG_AELYS_INPUT_SELFTEST
static volatile uint32_t st_int_edges;
#endif
static void IRAM_ATTR touch_isr(void *arg)
{
    touch_irq = true;
#ifdef CONFIG_AELYS_INPUT_SELFTEST
    st_int_edges++;
#endif
}

#ifdef CONFIG_AELYS_INPUT_SELFTEST
static volatile bool st_boot, st_pwr; /* synthetic key holds from the self-test */
static volatile uint32_t st_touch_read_us_sum, st_touch_read_us_max, st_touch_reads;
#endif

static esp_err_t axp_rd(uint8_t reg, uint8_t *v) { return i2c_master_transmit_receive(axp, &reg, 1, v, 1, 50); }
static esp_err_t axp_wr(uint8_t reg, uint8_t v)
{
    const uint8_t b[2] = {reg, v};
    return i2c_master_transmit(axp, b, 2, 50);
}

/* Read-modify-write of `mask` bits only: other power settings stay untouched. */
static esp_err_t axp_set(uint8_t reg, uint8_t mask, uint8_t val)
{
    uint8_t before, after;
    ESP_RETURN_ON_ERROR(axp_rd(reg, &before), TAG, "read 0x%02X", reg);
    ESP_RETURN_ON_ERROR(axp_wr(reg, (before & ~mask) | (val & mask)), TAG, "write 0x%02X", reg);
    ESP_RETURN_ON_ERROR(axp_rd(reg, &after), TAG, "readback 0x%02X", reg);
    ESP_LOGI(TAG, "AXP2101 0x%02X: 0x%02X -> 0x%02X", reg, before, after);
    return (after & mask) == (val & mask) ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

static esp_err_t axp_pwrkey_init(void)
{
    const i2c_device_config_t cfg = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = I2C_ADDR_AXP2101,
                                     .scl_speed_hz = 400000};
    ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(board_i2c_bus(), &cfg, &axp), TAG, "AXP2101 device");
    ESP_RETURN_ON_ERROR(axp_set(AXP_PWRKEY_TIMES, 0x03, AXP_OFF_10S), TAG, "power-off time");
    ESP_RETURN_ON_ERROR(axp_set(AXP_IRQ_EN1, AXP_PKEY_POS | AXP_PKEY_NEG, AXP_PKEY_POS | AXP_PKEY_NEG), TAG, "irq enable");
    return axp_wr(AXP_IRQ_STS1, AXP_PKEY_POS | AXP_PKEY_NEG); /* drop edges latched before we listened */
}

static esp_err_t touch_init(void)
{
    const esp_lcd_touch_config_t cfg = {
        .x_max = LCD_W,
        .y_max = LCD_H,
        .rst_gpio_num = PIN_TOUCH_RST,
        .int_gpio_num = PIN_TOUCH_INT,
        .levels = {.reset = 0, .interrupt = 0},
        .flags = {.swap_xy = 0, .mirror_x = 1, .mirror_y = 1}, /* as the Waveshare BSP */
    };
    esp_lcd_panel_io_handle_t io;
    esp_lcd_panel_io_i2c_config_t io_cfg = ESP_LCD_TOUCH_IO_I2C_CST9217_CONFIG();
    io_cfg.scl_speed_hz = 400000;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_i2c(board_i2c_bus(), &io_cfg, &io), TAG, "touch io");
    return esp_lcd_touch_new_i2c_cst9217(io, &cfg, &touch);
}

static bool post(uint8_t type, int pct)
{
    ui_event_t ev = {.type = type, .len = pct >= 0 ? 1 : 0, .data = {(uint8_t)pct}};
    return lv_port_post(&ev);
}

/* true while a finger is down */
static bool touch_down(uint16_t *x, uint16_t *y)
{
    uint8_t n = 0;
    touch_irq = false;
#ifdef CONFIG_AELYS_INPUT_SELFTEST
    int64_t t0 = esp_timer_get_time();
#endif
    esp_err_t err = esp_lcd_touch_read_data(touch);
#ifdef CONFIG_AELYS_INPUT_SELFTEST
    uint32_t dt = (uint32_t)(esp_timer_get_time() - t0);
    st_touch_reads++;
    st_touch_read_us_sum += dt;
    if (dt > st_touch_read_us_max) st_touch_read_us_max = dt;
#endif
    if (err != ESP_OK) return false;
    esp_lcd_touch_point_data_t pt;
    if (esp_lcd_touch_get_data(touch, &pt, &n, 1) != ESP_OK || n == 0) return false;
    *x = pt.x;
    *y = pt.y;
    return true;
}

#ifdef CONFIG_AELYS_INPUT_SELFTEST
/* Real taps on the ICE card: from just before the I2C read that saw the finger to the end of the
 * refresh that drew the home screen. Reported per 20 taps. A tap on any other screen redraws nothing,
 * so only taps while this task knows the card is open count. */
#define TAP_N 20
static uint32_t tap_t0, tap_lat_us[TAP_N];
static bool tap_pending, ice_open;
static int tap_n;
static uint32_t ice_open_ms;
static TaskHandle_t input_h;

static int cmp_u32(const void *a, const void *b)
{
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return x < y ? -1 : x > y;
}

static void tap_poll(void)
{
    if (!tap_pending) return;
    uint32_t done = lv_port_last_flush_end_us(), now = (uint32_t)esp_timer_get_time();
    if ((int32_t)(done - tap_t0) > 0) {
        tap_pending = false;
        tap_lat_us[tap_n++] = done - tap_t0;
        ESP_LOGW(TAG, "touch -> flush end %u us (tap %d/%d)", (unsigned)(done - tap_t0), tap_n, TAP_N);
        if (tap_n == TAP_N) {
            qsort(tap_lat_us, TAP_N, sizeof tap_lat_us[0], cmp_u32);
            ESP_LOGW(TAG, "touch latency n=%d median=%u ms max=%u ms (stack high-water %u bytes)", TAP_N,
                     (unsigned)(tap_lat_us[TAP_N / 2] / 1000), (unsigned)(tap_lat_us[TAP_N - 1] / 1000),
                     (unsigned)uxTaskGetStackHighWaterMark(input_h));
            tap_n = 0;
        }
    } else if (now - tap_t0 > 300000) {
        tap_pending = false;
        ESP_LOGW(TAG, "tap: no redraw within 300 ms (not counted)");
    }
}
#endif

#ifdef CONFIG_AELYS_PERF_PROBE
static _Atomic bool pr_input_busy = true; /* fail closed until the input task has sampled hardware */
bool board_probe_input_busy(void) { return atomic_load(&pr_input_busy); }
/* A single diagnostic request. The UI task validates its screen/input state;
 * no synthetic TOUCH, RELEASE or user gesture ever enters the action handlers. */
static void probe_swipe(void)
{
    static uint32_t last_ms;
    uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
    if (now - last_ms < 2000) return;
    last_ms = now;
    uint32_t posted_us = (uint32_t)esp_timer_get_time();
    ui_event_t ev = {.type = BOARD_UI_EV_PERF, .len = sizeof posted_us};
    memcpy(ev.data, &posted_us, sizeof posted_us);
    lv_port_post(&ev); /* the port counts a refused enqueue; there is no partial touch to leave behind */
}
#endif

static void input_task(void *arg)
{
    combo_t combo;
    pwrkey_t pwrkey;
    combo_reset(&combo);
    pwrkey_reset(&pwrkey);
    gesture_ctx_t gctx = {0};
    level_t lvl = {0};
    int32_t lvl_sent = 0;
    btn_ctx_t bctx = {0};
    debounce_t boot_deb = {0}; /* for the click only: the combo has its own 2 s timing */
    bool moved_sent = false;   /* UI_EV_RELEASE already sent for this touch because the finger moved */
    gesture_t pend_gest = GEST_NONE; /* a tap or swipe the ui queue had no room for yet */
    bool was_touched = false, fire_pending = false, release_pending = false;
#ifdef CONFIG_AELYS_PERF_PROBE
    bool probe_physical_touch = false;
#endif
    int shown = 0; /* the last progress percent the ui was told about */
    uint32_t pass = 0;
    TickType_t wake = xTaskGetTickCount();

    for (;;) {
        bool slow = ++pass % SLOW_PASSES == 0;

        /* INT is active low; while a finger is down the release is found by a read every 20 ms */
        if (touch && (touch_irq || gpio_get_level(PIN_TOUCH_INT) == 0 || (was_touched && slow))) {
            uint16_t x = 0, y = 0;
#ifdef CONFIG_AELYS_INPUT_SELFTEST
            uint32_t t0 = (uint32_t)esp_timer_get_time();
#endif
            bool down = touch_down(&x, &y);
#ifdef CONFIG_AELYS_PERF_PROBE
            probe_physical_touch = down;
            if (down) atomic_store(&pr_input_busy, true); /* before attempting any queue post */
#endif
            gesture_t gs = gesture_feed(&gctx, down, (int16_t)x, (int16_t)y, (uint32_t)(esp_timer_get_time() / 1000));
            if (gs != GEST_NONE) pend_gest = gs;
            /* a finger that moved 20 px is no hold: tell the ui as if it had lifted (the real lift sends one more, harmless) */
            if (down && !moved_sent && gesture_moved(&gctx)) moved_sent = post(UI_EV_RELEASE, 1);
            if (!down) moved_sent = false;
            if (!down) {
                release_pending = release_pending || was_touched; /* the ui hears the lift after the gesture */
                was_touched = false;
            } else if (!was_touched) {
                ui_event_t ev = {.type = UI_EV_TOUCH, .len = 4, .data = {x, x >> 8, y, y >> 8}};
                was_touched = lv_port_post(&ev); /* a dropped tap is retried on the next read */
#ifdef CONFIG_AELYS_INPUT_SELFTEST
                if (was_touched && ice_open && (uint32_t)(esp_timer_get_time() / 1000) - ice_open_ms < 15000) {
                    tap_t0 = t0;
                    tap_pending = true;
                    ice_open = false;
                }
#endif
            }
        }
        if (pend_gest != GEST_NONE) {
            ui_event_t ev = {.type = pend_gest == GEST_TAP ? UI_EV_TAP : pend_gest == GEST_SWIPE_LEFT ? UI_EV_SWIPE_LEFT : UI_EV_SWIPE_RIGHT};
            if (pend_gest == GEST_TAP) { ev.len = 4; ev.data[0] = gctx.x; ev.data[1] = gctx.x >> 8; ev.data[2] = gctx.y; ev.data[3] = gctx.y >> 8; }
            if (lv_port_post(&ev)) pend_gest = GEST_NONE;
        }
        if (release_pending && pend_gest == GEST_NONE && post(UI_EV_RELEASE, 0)) release_pending = false;

        if (axp && slow) {
            uint8_t sts;
            if (axp_rd(AXP_IRQ_STS1, &sts) == ESP_OK) {
                uint8_t edges = sts & (AXP_PKEY_POS | AXP_PKEY_NEG);
                /* the edges count only once cleared: a failed clear is read again next poll */
                if (edges && axp_wr(AXP_IRQ_STS1, edges) == ESP_OK)
                    pwrkey_update(&pwrkey, edges & AXP_PKEY_NEG, edges & AXP_PKEY_POS,
                                  (uint32_t)(esp_timer_get_time() / 1000));
                if (edges) ESP_LOGI(TAG, "PWR key edges 0x%X, now %s", edges, pwrkey.down ? "down" : "up");
            }
        }
        /* no edge: only ages the state, so a lost release edge cannot leave the key down for good */
        bool pwr = pwrkey_update(&pwrkey, false, false, (uint32_t)(esp_timer_get_time() / 1000));
        bool boot = gpio_get_level(PIN_BOOT) == 0;
#ifdef CONFIG_AELYS_INPUT_SELFTEST
        boot = boot || st_boot;
        pwr = pwr || st_pwr;
#endif
        ui_btn_t click = btn_feed(&bctx, pwr, debounce_feed(&boot_deb, boot), (uint32_t)(esp_timer_get_time() / 1000)); /* top = PWR: see the top of this file */
        if (click) post(UI_EV_BTN, click);
        int pct = combo_update(&combo, boot, pwr, (uint32_t)(esp_timer_get_time() / 1000));
        if (pct == 100) {
            fire_pending = true;
            shown = 0; /* the ui clears the overlay itself when the card opens */
        } else if (pct >= 0) {
            if (pct != shown && post(UI_EV_COMBO_PROGRESS, pct)) shown = pct;
        } else if (shown != 0 && post(UI_EV_COMBO_PROGRESS, 0)) {
            shown = 0; /* released or cancelled: take the overlay down */
        }
        if (fire_pending && post(UI_EV_COMBO_FIRE, -1)) {
            fire_pending = false;
            ESP_LOGW(TAG, "combo fired: BOOT + PWR held %d ms", COMBO_HOLD_MS);
#ifdef CONFIG_AELYS_INPUT_SELFTEST
            ice_open = true;
            ice_open_ms = (uint32_t)(esp_timer_get_time() / 1000);
#endif
        }
        int16_t ax, ay, az;
        if (pass % IMU_PASSES == 0 && board_imu_read(&ax, &ay, &az)) {
            int32_t a = level_update_3d(&lvl, IMU_SCREEN_X(ax, ay), IMU_SCREEN_Y(ax, ay), az);
            if (a != lvl_sent) {
                ui_event_t ev = {.type = UI_EV_LEVEL, .len = 2, .data = {(uint8_t)a, (uint8_t)((uint16_t)a >> 8)}};
                if (lv_port_post(&ev)) {
                    lvl_sent = a; /* a full queue retries on the next sample */
                    static int64_t logged_us;
                    int64_t now_us = esp_timer_get_time();
                    if (now_us - logged_us >= 1000000) { /* at most once a second, only while turning */
                        logged_us = now_us;
                        ESP_LOGW(TAG, "level %ld from ax=%d ay=%d az=%d", (long)a, ax, ay, az);
                    }
                }
            }
        }
#ifdef CONFIG_AELYS_INPUT_SELFTEST
        tap_poll();
#endif
#ifdef CONFIG_AELYS_PERF_PROBE
        atomic_store(&pr_input_busy, !touch || probe_physical_touch || boot || pwr ||
                     pend_gest != GEST_NONE || release_pending || fire_pending);
        probe_swipe();
#endif
        xTaskDelayUntil(&wake, pdMS_TO_TICKS(POLL_MS));
    }
}

#ifdef CONFIG_AELYS_INPUT_SELFTEST
#include "esp_heap_caps.h"

static void report(const char *what, uint32_t *v, int n)
{
    qsort(v, n, sizeof *v, cmp_u32);
    ESP_LOGW(TAG, "SELFTEST %s: n=%d median=%u us max=%u us", what, n, (unsigned)v[n / 2], (unsigned)v[n - 1]);
}

/* ui event queued -> end of the refresh that drew it, for the heaviest case: a whole-screen change */
static uint32_t timed(uint8_t type)
{
    uint32_t t0 = (uint32_t)esp_timer_get_time();
    post(type, -1);
    while ((int32_t)(lv_port_last_flush_end_us() - t0) <= 0 && (uint32_t)esp_timer_get_time() - t0 < 500000)
        vTaskDelay(1);
    return lv_port_last_flush_end_us() - t0;
}

static void selftest_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(4000));
    uint32_t fire[20], tap[20];
    for (int i = 0; i < 20; i++) {
        vTaskDelay(pdMS_TO_TICKS(300));
        fire[i] = timed(UI_EV_COMBO_FIRE); /* home -> ICE card */
        vTaskDelay(pdMS_TO_TICKS(300));
        tap[i] = timed(UI_EV_TOUCH); /* ICE card -> home */
    }
    report("event->flush, combo fire (home->ICE)", fire, 20);
    report("event->flush, tap (ICE->home)", tap, 20);
    ESP_LOGW(TAG, "SELFTEST touch I2C read: n=%u avg=%u us max=%u us", (unsigned)st_touch_reads,
             (unsigned)(st_touch_read_us_sum / (st_touch_reads ? st_touch_reads : 1)), (unsigned)st_touch_read_us_max);

    /* a hold released after 0.7 s must not open anything and must clear the ring */
    st_boot = st_pwr = true;
    vTaskDelay(pdMS_TO_TICKS(700));
    st_boot = st_pwr = false;
    vTaskDelay(pdMS_TO_TICKS(300));
    /* a full hold fires once */
    st_boot = st_pwr = true;
    vTaskDelay(pdMS_TO_TICKS(2400));
    st_boot = st_pwr = false;
    vTaskDelay(pdMS_TO_TICKS(500));
    post(UI_EV_TOUCH, -1);
    vTaskDelay(pdMS_TO_TICKS(500));

    /* sustained ring animation: 1.9 s holds (no fire) for ~17 s, frame stats printed as they publish */
    uint32_t last_fps = 0, last_worst = 0;
    for (int i = 0; i < 9; i++) {
        st_boot = st_pwr = true;
        for (int ms = 0; ms < 1900; ms += 100) {
            vTaskDelay(pdMS_TO_TICKS(100));
            uint32_t fps, worst;
            lv_port_frame_stats(&fps, &worst);
            if (fps != last_fps || worst != last_worst) {
                ESP_LOGW(TAG, "SELFTEST frames: %u.%u fps, worst %u us", (unsigned)fps / 10, (unsigned)fps % 10, (unsigned)worst);
                last_fps = fps;
                last_worst = worst;
            }
        }
        st_boot = st_pwr = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    ESP_LOGW(TAG, "SELFTEST heap: free_internal=%u min_free_internal=%u free_spiram=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    ESP_LOGW(TAG, "SELFTEST INT falling edges during the run (no finger): %u; INT level now %d",
             (unsigned)st_int_edges, gpio_get_level(PIN_TOUCH_INT));
    ESP_LOGW(TAG, "SELFTEST input task stack high-water: %u of 4096 bytes free", (unsigned)uxTaskGetStackHighWaterMark(input_h));
    ESP_LOGW(TAG, "SELFTEST DONE");
    vTaskDelete(NULL);
}
#endif

esp_err_t board_input_start(void)
{
    esp_err_t first = touch_init();
    if (first != ESP_OK) ESP_LOGE(TAG, "touch init failed (%s): no touch input", esp_err_to_name(first));
    const gpio_config_t boot = {.pin_bit_mask = 1ULL << PIN_BOOT, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE};
    esp_err_t err = gpio_config(&boot);
    if (first == ESP_OK) first = err;
    err = axp_pwrkey_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "AXP2101 PWR key setup failed (%s): no two-button combo", esp_err_to_name(err));
        axp = NULL;
        if (first == ESP_OK) first = err;
    }
    if (touch) {
        /* the touch driver already set PIN_TOUCH_INT up as an input with a falling-edge interrupt */
        err = gpio_isr_handler_add(PIN_TOUCH_INT, touch_isr, NULL);
        if (err == ESP_ERR_INVALID_STATE && (err = gpio_install_isr_service(0)) == ESP_OK) /* lv_port normally did it */
            err = gpio_isr_handler_add(PIN_TOUCH_INT, touch_isr, NULL);
        if (err != ESP_OK) ESP_LOGW(TAG, "touch INT edge latch off (%s): level polling only", esp_err_to_name(err));
    }
#ifndef CONFIG_AELYS_INPUT_SELFTEST
    TaskHandle_t input_h;
#endif
    if (xTaskCreatePinnedToCore(input_task, "input", 4096, NULL, 5, &input_h, 0) != pdPASS) return ESP_ERR_NO_MEM;
#ifdef CONFIG_AELYS_INPUT_SELFTEST
    xTaskCreatePinnedToCore(selftest_task, "selftest", 4096, NULL, 4, NULL, 0);
#endif
    return first;
}
