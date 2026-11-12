/* Input glue: CST9217 touch, the BOOT key (GPIO0, active low) and the AXP2101 PWR key.
 * The PWR key reaches the SoC only through the PMIC, so it is read as PKEY press/release edge
 * interrupts, polled and cleared over I2C every 20 ms (the PMIC IRQ line is not wired).
 * BOOT + PWR held COMBO_HOLD_MS opens the ICE card; the PMIC's own long-press power-off is pushed
 * out to 10 s so the 2 s hold can never power the board off. */
#include <stdint.h>

#include "board.h"
#include "board_pins.h"
#include "combo.h"
#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch_cst9217.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "input";

#define POLL_MS 10 /* touch every pass, the PMIC every second pass */

/* AXP2101 registers (datasheet / XPowersLib) */
#define AXP_PWRKEY_TIMES 0x27 /* [5:4] IRQ time, [3:2] power-on time, [1:0] power-off time: 4/6/8/10 s */
#define AXP_IRQ_EN1      0x41 /* bit0 PKEY positive edge (release), bit1 PKEY negative edge (press) */
#define AXP_IRQ_STS1     0x49 /* same bits, latched, write 1 to clear */
#define AXP_PKEY_POS     (1u << 0)
#define AXP_PKEY_NEG     (1u << 1)
#define AXP_OFF_10S      0x03

static i2c_master_dev_handle_t axp;
static esp_lcd_touch_handle_t touch;

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

static void input_task(void *arg)
{
    combo_t combo;
    combo_reset(&combo);
    bool was_touched = false, pwr_real = false, fire_pending = false;
    int shown = 0; /* the last progress percent the ui was told about */
    uint32_t pass = 0;
    TickType_t wake = xTaskGetTickCount();

    for (;;) {
        if (touch) {
            uint16_t x = 0, y = 0;
            if (!touch_down(&x, &y)) {
                was_touched = false;
            } else if (!was_touched) {
                ui_event_t ev = {.type = UI_EV_TOUCH, .len = 4, .data = {x, x >> 8, y, y >> 8}};
                was_touched = lv_port_post(&ev); /* a dropped tap is retried on the next pass */
#ifdef CONFIG_AELYS_INPUT_SELFTEST
                if (was_touched) {
                    uint32_t t0 = (uint32_t)esp_timer_get_time();
                    int32_t wait_ms = 0;
                    while ((int32_t)(lv_port_last_flush_end_us() - t0) <= 0 && wait_ms++ < 300) vTaskDelay(1);
                    ESP_LOGW(TAG, "touch (%u,%u) -> flush end %d ms", x, y,
                             wait_ms > 300 ? -1 : (int)((lv_port_last_flush_end_us() - t0) / 1000));
                }
#endif
            }
        }

        if (axp && (pass++ & 1) == 0) {
            uint8_t sts;
            if (axp_rd(AXP_IRQ_STS1, &sts) == ESP_OK && (sts & (AXP_PKEY_POS | AXP_PKEY_NEG))) {
                axp_wr(AXP_IRQ_STS1, sts & (AXP_PKEY_POS | AXP_PKEY_NEG));
                /* both edges in one poll = a quick tap: ends released */
                if (sts & AXP_PKEY_NEG) pwr_real = true;
                if (sts & AXP_PKEY_POS) pwr_real = false;
                ESP_LOGI(TAG, "PWR key %s", pwr_real ? "down" : "up");
            }
        }

        bool boot = gpio_get_level(PIN_BOOT) == 0, pwr = pwr_real;
#ifdef CONFIG_AELYS_INPUT_SELFTEST
        boot = boot || st_boot;
        pwr = pwr || st_pwr;
#endif
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
        }
        xTaskDelayUntil(&wake, pdMS_TO_TICKS(POLL_MS));
    }
}

#ifdef CONFIG_AELYS_INPUT_SELFTEST
#include "esp_heap_caps.h"

static int cmp_u32(const void *a, const void *b)
{
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return x < y ? -1 : x > y;
}

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
    if (xTaskCreatePinnedToCore(input_task, "input", 4096, NULL, 5, NULL, 0) != pdPASS) return ESP_ERR_NO_MEM;
#ifdef CONFIG_AELYS_INPUT_SELFTEST
    xTaskCreatePinnedToCore(selftest_task, "selftest", 4096, NULL, 4, NULL, 0);
#endif
    return first;
}
