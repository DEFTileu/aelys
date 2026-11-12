/* Own LVGL port for the CO5300 panel: partial rendering into two small internal DMA buffers, strips
 * go out over QSPI by DMA while LVGL draws the next one, and the first strip of every frame waits for
 * the panel's TE pulse so the write always runs ahead of the scan (no tearing). */
#include <limits.h>
#include <stdbool.h>

#include "board.h"
#include "board_pins.h"
#include "board_priv.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"

static const char *TAG = "lv_port";

#define BUF_ROWS       32
#define BUF_BYTES      (LCD_W * BUF_ROWS * 2)
#define TE_TIMEOUT_MS  25 /* go on regardless if the TE line ever goes quiet */
#define EV_QUEUE_DEPTH 16
#define STATS_WINDOW_US (5 * 1000 * 1000)

static QueueHandle_t ev_queue;
static void (*ev_handler)(const ui_event_t *);
static void (*setup_cb)(void);
static TaskHandle_t starter;
static lv_display_t *disp;

static SemaphoreHandle_t te_sem, dma_sem;
static volatile bool dma_busy;
static bool need_te;       /* the next flush is the first of a frame */
static bool frame_flushed; /* this refresh sent something to the panel */

/* frame statistics: the window being filled, and the last full window */
static int64_t win_start, refr_start;
static uint32_t win_frames, win_worst;
static volatile uint32_t out_fps_x10, out_worst_us;

/* ---- LVGL heap in PSRAM (LV_USE_CUSTOM_MALLOC). The draw buffers below stay in internal RAM. ---- */
void lv_mem_init(void) {}
void lv_mem_deinit(void) {}
lv_mem_pool_t lv_mem_add_pool(void *mem, size_t bytes) { (void)mem; (void)bytes; return NULL; }
void lv_mem_remove_pool(lv_mem_pool_t pool) { (void)pool; }
void *lv_malloc_core(size_t size) { return heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }
void *lv_realloc_core(void *p, size_t size) { return heap_caps_realloc(p, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }
void lv_free_core(void *p) { heap_caps_free(p); }
lv_result_t lv_mem_test_core(void) { return LV_RESULT_OK; }
void lv_mem_monitor_core(lv_mem_monitor_t *mon)
{
    multi_heap_info_t info;
    heap_caps_get_info(&info, MALLOC_CAP_SPIRAM);
    lv_memzero(mon, sizeof *mon);
    mon->total_size = info.total_free_bytes + info.total_allocated_bytes;
    mon->free_size = info.total_free_bytes;
    mon->free_biggest_size = info.largest_free_block;
    mon->used_pct = (uint8_t)(100 * info.total_allocated_bytes / (mon->total_size ? mon->total_size : 1));
}

/* ---- display ---- */
static void IRAM_ATTR te_isr(void *arg)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(te_sem, &woken);
    if (woken) portYIELD_FROM_ISR();
}

/* The SPI ISR runs even while the flash cache is off (SPI_MASTER_ISR_IN_IRAM), so this may not call
 * into LVGL; lv_display_flush_ready() is replaced by flush_wait() below. */
static bool IRAM_ATTR color_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *ev, void *ctx)
{
    BaseType_t woken = pdFALSE;
    dma_busy = false;
    xSemaphoreGiveFromISR(dma_sem, &woken);
    return woken == pdTRUE;
}

static void flush_cb(lv_display_t *d, const lv_area_t *a, uint8_t *px)
{
    if (need_te) {
        need_te = false;
        xSemaphoreTake(te_sem, 0); /* an old pulse does not count */
        xSemaphoreTake(te_sem, pdMS_TO_TICKS(TE_TIMEOUT_MS));
    }
    frame_flushed = true;
    dma_busy = true;
    if (esp_lcd_panel_draw_bitmap(board_panel(), a->x1, a->y1, a->x2 + 1, a->y2 + 1, px) != ESP_OK) {
        dma_busy = false; /* a lost strip beats a frozen UI */
    }
}

/* LVGL clears its own "flushing" flag once this returns. Loop: dma_sem may hold a stale give. */
static void flush_wait(lv_display_t *d)
{
    while (dma_busy) {
        if (xSemaphoreTake(dma_sem, pdMS_TO_TICKS(100)) != pdTRUE) {
            ESP_LOGW(TAG, "flush wait timeout");
            break;
        }
    }
}

/* CO5300 takes only windows that start on an even and end on an odd pixel. LVGL also asks this for the
 * strip height (get_max_row), so strips stay even too. */
static void round_area(lv_event_t *e)
{
    lv_area_t *a = lv_event_get_param(e);
    a->x1 &= ~1;
    a->y1 &= ~1;
    a->x2 |= 1;
    a->y2 |= 1;
}

static void stats_tick(int64_t now)
{
    int64_t span = now - win_start;
    if (span < STATS_WINDOW_US) return;
    out_fps_x10 = (uint32_t)((uint64_t)win_frames * 10 * 1000000 / (uint64_t)span);
    out_worst_us = win_worst;
    win_start = now;
    win_frames = win_worst = 0;
}

static void disp_event(lv_event_t *e)
{
    int64_t now = esp_timer_get_time();
    switch (lv_event_get_code(e)) {
    case LV_EVENT_REFR_START:
        refr_start = now;
        need_te = true;
        frame_flushed = false;
        break;
    case LV_EVENT_REFR_READY:
        if (!frame_flushed) break; /* nothing was invalid: not a frame */
        win_frames++;
        if ((uint32_t)(now - refr_start) > win_worst) win_worst = (uint32_t)(now - refr_start);
        stats_tick(now);
        break;
    default:
        break;
    }
}

static uint32_t tick_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

static esp_err_t lvgl_start(void)
{
    te_sem = xSemaphoreCreateBinary();
    dma_sem = xSemaphoreCreateBinary();
    if (!te_sem || !dma_sem) return ESP_ERR_NO_MEM;

    void *buf[2];
    for (int i = 0; i < 2; i++) {
        buf[i] = heap_caps_aligned_alloc(LV_DRAW_BUF_ALIGN, BUF_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
        if (!buf[i]) return ESP_ERR_NO_MEM;
    }

    lv_init();
    lv_tick_set_cb(tick_ms);
    disp = lv_display_create(LCD_W, LCD_H);
    if (!disp) return ESP_ERR_NO_MEM;
    /* the panel wants big-endian RGB565: LVGL draws it that way, so the strips go out untouched */
    lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565_SWAPPED);
    lv_display_set_buffers(disp, buf[0], buf[1], BUF_BYTES, LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(disp, flush_cb);
    lv_display_set_flush_wait_cb(disp, flush_wait);
    lv_display_add_event_cb(disp, round_area, LV_EVENT_INVALIDATE_AREA, NULL);
    lv_display_add_event_cb(disp, disp_event, LV_EVENT_REFR_START, NULL);
    lv_display_add_event_cb(disp, disp_event, LV_EVENT_REFR_READY, NULL);

    const esp_lcd_panel_io_callbacks_t cbs = {.on_color_trans_done = color_done};
    esp_err_t err = esp_lcd_panel_io_register_event_callbacks(board_panel_io(), &cbs, NULL);
    if (err != ESP_OK) return err;

    const gpio_config_t te = {.pin_bit_mask = 1ULL << PIN_LCD_TE, .mode = GPIO_MODE_INPUT, .intr_type = GPIO_INTR_POSEDGE};
    err = gpio_config(&te);
    if (err != ESP_OK) return err;
    err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err; /* already installed is fine */
    return gpio_isr_handler_add(PIN_LCD_TE, te_isr, NULL);
}

static void ui_task(void *arg)
{
    esp_err_t err = lvgl_start();
    if (err == ESP_OK && setup_cb) setup_cb();
    xTaskNotify(starter, (uint32_t)err, eSetValueWithOverwrite);
    if (err != ESP_OK) vTaskDelete(NULL);

    win_start = esp_timer_get_time();
    for (;;) {
        uint32_t wait = lv_timer_handler();
        stats_tick(esp_timer_get_time()); /* also publishes while the screen is idle */
        if (wait < 1) wait = 1;
        if (wait > 16) wait = 16;
        ui_event_t ev;
        /* sleeps until the next LVGL timer, or until an event arrives */
        for (BaseType_t got = xQueueReceive(ev_queue, &ev, pdMS_TO_TICKS(wait)); got == pdTRUE;
             got = xQueueReceive(ev_queue, &ev, 0)) {
            if (ev_handler) ev_handler(&ev);
        }
    }
}

esp_err_t lv_port_start(void (*ui_setup)(void))
{
    setup_cb = ui_setup;
    ev_queue = xQueueCreate(EV_QUEUE_DEPTH, sizeof(ui_event_t));
    if (!ev_queue) return ESP_ERR_NO_MEM;
    starter = xTaskGetCurrentTaskHandle();
    if (xTaskCreatePinnedToCore(ui_task, "ui", 10240, NULL, 6, NULL, 1) != pdPASS) return ESP_ERR_NO_MEM;
    uint32_t res = ESP_ERR_TIMEOUT;
    if (xTaskNotifyWait(0, ULONG_MAX, &res, pdMS_TO_TICKS(5000)) != pdTRUE) return ESP_ERR_TIMEOUT;
    return (esp_err_t)res;
}

void lv_port_post(const ui_event_t *ev)
{
    if (ev_queue) xQueueSend(ev_queue, ev, 0);
}

void lv_port_set_handler(void (*fn)(const ui_event_t *)) { ev_handler = fn; }

void lv_port_frame_stats(uint32_t *fps_x10, uint32_t *worst_us)
{
    if (fps_x10) *fps_x10 = out_fps_x10;
    if (worst_us) *worst_us = out_worst_us;
}
