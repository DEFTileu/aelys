/* Runtime metrics: one WARN line per period, so it shows at the release log level. Only reads
 * counters, so the render path is never touched. */
#include "metrics.h"

#include <stdint.h>

#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "link.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "metrics";

static uint32_t period_ms;

static uint32_t stack_free(const char *name)
{
    TaskHandle_t h = xTaskGetHandle(name);
    return h ? uxTaskGetStackHighWaterMark(h) : 0; /* bytes free at the deepest point so far */
}

static int battery_pct(void) /* -1 = no battery or the gauge does not answer */
{
    uint8_t pct = 0;
    bool charging = false;
    return board_battery(&pct, &charging) ? pct : -1;
}

static void metrics_task(void *arg)
{
    (void)arg;
    for (;;) {
        /* every second: frames actually drawn, only while something moves (2+ frames), to read the real rate */
        for (uint32_t waited = 0; waited < period_ms; waited += 1000) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            uint32_t frames, worst;
            lv_port_frame_take(&frames, &worst);
            if (frames >= 2) ESP_LOGW(TAG, "fps1s frames=%u worst_us=%u", (unsigned)frames, (unsigned)worst);
        }
        uint32_t fps_x10 = 0, worst_us = 0;
        lv_port_frame_stats(&fps_x10, &worst_us);
        esp_netif_ip_info_t ip = {0};
        esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        if (sta) esp_netif_get_ip_info(sta, &ip);
        ESP_LOGW(TAG,
                 "metrics heap_int=%u heap_int_min=%u largest=%u psram=%u fps=%u.%u worst_us=%u hwm_ui=%u hwm_net=%u "
                 "hwm_in=%u battery=%d hwm_link=%u hwm_ws=%u hwm_tmr=%u boot_ms=%u wifi_ip=%d heap_at_connect_min=%u tls_fail=%u",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), (unsigned)(fps_x10 / 10), (unsigned)(fps_x10 % 10),
                 (unsigned)worst_us, (unsigned)stack_free("ui"), (unsigned)stack_free("net"), (unsigned)stack_free("input"), battery_pct(),
                 (unsigned)stack_free("link"), (unsigned)link_ws_stack_free_min(), (unsigned)stack_free("esp_timer"),
                 (unsigned)(lv_port_first_flush_end_us() / 1000), ip.ip.addr != 0, (unsigned)link_heap_at_connect_min(),
                 (unsigned)link_tls_failures());
    }
}

#ifdef CONFIG_AELYS_PERF_PROBE
#include "esp_timer.h"
#include "freertos/idf_additions.h"

/* uxTaskGetSystemState requires room for every task or returns zero. Its task
 * name pointers can outlive a deleted task, so identify rows by task number.
 * Affinity is a constraint, not evidence of which core executed an unpinned task. */
#define PROBE_TASK_CAPACITY 64
static void probe_runtime_report(void)
{
    static TaskStatus_t rows[PROBE_TASK_CAPACITY];
    static struct { TaskHandle_t handle; UBaseType_t number; uint64_t runtime; } prev[PROBE_TASK_CAPACITY];
    static UBaseType_t prev_count;
    static uint64_t prev_total;
    configRUN_TIME_COUNTER_TYPE total = 0;
    int64_t start = esp_timer_get_time();
    UBaseType_t n = uxTaskGetSystemState(rows, PROBE_TASK_CAPACITY, &total);
    int64_t duration = esp_timer_get_time() - start;
    if (!n) {
        ESP_LOGW(TAG, "perf_rt incomplete=1 capacity=%u snapshot_us=%lld", PROBE_TASK_CAPACITY, (long long)duration);
        return; /* retain the previous complete baseline */
    }
    TaskHandle_t idle0 = xTaskGetIdleTaskHandleForCore(0);
    TaskHandle_t idle1 = xTaskGetIdleTaskHandleForCore(1);
    /* Name lookup is only a hint: tasks can exit or their handles be reused. */
    static const char *const names[] = {"ui", "link", "ws_link", "tcpip", "input", "net", "probe", "metrics"};
    TaskHandle_t named[sizeof names / sizeof names[0]];
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) named[i] = xTaskGetHandle(names[i]);
    ESP_LOGW(TAG, "perf_rt incomplete=0 tasks=%u snapshot_us=%lld total_delta_us=%llu baseline=%u",
             (unsigned)n, (long long)duration, (unsigned long long)(prev_count ? total - prev_total : 0), prev_count != 0);
    for (UBaseType_t i = 0; i < n; i++) {
        bool found = false;
        uint64_t delta = 0;
        for (UBaseType_t j = 0; j < prev_count; j++) {
            if (prev[j].handle == rows[i].xHandle && prev[j].number == rows[i].xTaskNumber &&
                rows[i].ulRunTimeCounter >= prev[j].runtime) {
                delta = rows[i].ulRunTimeCounter - prev[j].runtime;
                found = true;
                break;
            }
        }
        int affinity = rows[i].xCoreID == 0 || rows[i].xCoreID == 1 ? (int)rows[i].xCoreID : -1;
        int idle = rows[i].xHandle == idle0 ? 0 : rows[i].xHandle == idle1 ? 1 : -1;
        const char *hint = "unknown";
        for (size_t j = 0; j < sizeof names / sizeof names[0]; j++)
            if (named[j] && named[j] == rows[i].xHandle) { hint = names[j]; break; }
        ESP_LOGW(TAG, "perf_rt_task id=%u name_hint=%s priority=%u affinity=%d idle=%d delta_us=%llu valid=%u",
                 (unsigned)rows[i].xTaskNumber, hint, (unsigned)rows[i].uxCurrentPriority, affinity, idle,
                 (unsigned long long)delta, found);
    }
    for (UBaseType_t i = 0; i < n; i++) {
        prev[i].handle = rows[i].xHandle;
        prev[i].number = rows[i].xTaskNumber;
        prev[i].runtime = rows[i].ulRunTimeCounter;
    }
    prev_count = n;
    prev_total = total;
}

static void probe_task(void *arg)
{
    (void)arg;
    uint32_t seconds = 0, sampled_min = UINT32_MAX;
    lv_port_probe_t previous = {0}, hist_base = {0};
    bool have_previous = false, have_hist_base = false;
    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        xTaskDelayUntil(&wake, pdMS_TO_TICKS(1000));
        seconds++;
        uint32_t heap = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
        if (heap < sampled_min) sampled_min = heap;
        lv_port_probe_t p;
        if (lv_port_probe_read(&p)) {
            uint32_t span_ms = have_previous ? p.sampled_ms - previous.sampled_ms : 0;
            uint32_t frames = have_previous ? p.frames - previous.frames : 0;
            uint64_t fps_x10 = span_ms ? (uint64_t)frames * 10000 / span_ms : 0;
            uint32_t skipped = have_previous ? p.seq - previous.seq - 1 : p.seq - 1;
            ESP_LOGW(TAG, "perf seq=%u skipped=%u sampled_ms=%u span_ms=%u frames_delta=%u fps_x10=%llu screen=%u link=%d heap=%u boot_min=%u sampled_min=%u largest=%u hwm_ws=%u",
                     (unsigned)p.seq, (unsigned)skipped, (unsigned)p.sampled_ms, (unsigned)span_ms,
                     (unsigned)frames, (unsigned long long)fps_x10, (unsigned)p.screen, link_probe_state(),
                     (unsigned)heap, (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)sampled_min, (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
                     (unsigned)link_ws_stack_free_min());
            ESP_LOGW(TAG, "perf_cumulative frames=%u n17=%u n25=%u worst_us=%u te_us=%u work_us=%u work_n17=%u handler_us=%u event_us=%u event_type=%u snaps=%u snap_us=%u",
                     (unsigned)p.frames, (unsigned)p.n17, (unsigned)p.n25, (unsigned)p.worst_us,
                     (unsigned)p.worst_te_us, (unsigned)p.work_max_us, (unsigned)p.work_n17,
                     (unsigned)p.handler_max_us, (unsigned)p.ev_max_us, (unsigned)p.ev_max_type,
                     (unsigned)p.snaps, (unsigned)p.snap_max_us);
            ESP_LOGW(TAG, "perf_swipe ok=%u refused=%u timeout=%u interrupted=%u dropped=%u max_us=%u last_us=%u frame_failed=%u transfer_failed=%u",
                     (unsigned)p.sw_ok, (unsigned)p.sw_refused, (unsigned)p.sw_timeout,
                     (unsigned)p.sw_interrupted, (unsigned)p.sw_dropped, (unsigned)p.sw_max_us, (unsigned)p.sw_last_us,
                     (unsigned)p.frames_failed, (unsigned)p.sw_transfer_failed);
            if (!have_hist_base) { hist_base = p; have_hist_base = true; }
            else if ((uint32_t)(p.sampled_ms - hist_base.sampled_ms) >= 60000) {
                ESP_LOGW(TAG, "perf_sw_hist span_ms=%u bin_us=5000 bins=0..20 overflow_bin=20",
                         (unsigned)(p.sampled_ms - hist_base.sampled_ms));
                for (unsigned i = 0; i < 21; i++)
                    ESP_LOGW(TAG, "perf_sw_hist bin=%u count=%u", i, (unsigned)(p.sw_hist[i] - hist_base.sw_hist[i]));
                hist_base = p;
            }
            previous = p;
            have_previous = true;
        } else {
            ESP_LOGW(TAG, "perf no_snapshot=1 link=%d heap=%u boot_min=%u sampled_min=%u largest=%u hwm_ws=%u",
                     link_probe_state(), (unsigned)heap,
                     (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL), (unsigned)sampled_min,
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL), (unsigned)link_ws_stack_free_min());
        }
        if (seconds % 10 == 0) probe_runtime_report();
    }
}
#endif

void metrics_start(uint32_t period_s)
{
    period_ms = period_s * 1000;
#ifdef CONFIG_AELYS_PERF_PROBE
    if (xTaskCreatePinnedToCore(probe_task, "probe", 4096, NULL, 2, NULL, 0) != pdPASS) ESP_LOGE(TAG, "probe not created");
#endif
    if (xTaskCreate(metrics_task, "metrics", 3072, NULL, 1, NULL) != pdPASS) ESP_LOGE(TAG, "task not created");
}
