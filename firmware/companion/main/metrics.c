/* Runtime metrics: one WARN line per period, so it shows at the release log level. Only reads
 * counters, so the render path is never touched. */
#include "metrics.h"

#include <stdint.h>

#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "metrics";

static uint32_t period_ms;

static uint32_t stack_free(const char *name)
{
    TaskHandle_t h = xTaskGetHandle(name);
    return h ? uxTaskGetStackHighWaterMark(h) : 0; /* bytes free at the deepest point so far */
}

static void metrics_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(period_ms));
        uint32_t fps_x10 = 0, worst_us = 0;
        lv_port_frame_stats(&fps_x10, &worst_us);
        esp_netif_ip_info_t ip = {0};
        esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        if (sta) esp_netif_get_ip_info(sta, &ip);
        ESP_LOGW(TAG,
                 "metrics heap_int=%u heap_int_min=%u largest=%u psram=%u fps=%u.%u worst_us=%u hwm_ui=%u hwm_net=%u "
                 "hwm_in=%u boot_ms=%u wifi_ip=%d",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), (unsigned)(fps_x10 / 10), (unsigned)(fps_x10 % 10),
                 (unsigned)worst_us, (unsigned)stack_free("ui"), (unsigned)stack_free("net"), (unsigned)stack_free("input"),
                 (unsigned)(lv_port_first_flush_end_us() / 1000), ip.ip.addr != 0);
    }
}

void metrics_start(uint32_t period_s)
{
    period_ms = period_s * 1000;
    if (xTaskCreate(metrics_task, "metrics", 3072, NULL, 1, NULL) != pdPASS) ESP_LOGE(TAG, "task not created");
}
