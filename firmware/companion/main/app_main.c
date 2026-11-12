#include <string.h>

#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "metrics.h"
#include "net.h"
#include "owner.h"
#include "store_nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ui.h"

#define FW_VERSION "0.1.0"

static const char *TAG = "companion";

/* The ui copies from these on receipt, so they must stay valid until it has drained the queue. */
static owner_info_t owner;
static lost_state_t lost;

/* Runs in the ui task (LVGL lock held) before the first frame. */
static void boot_ui_setup(void)
{
    ui_setup();
    ui_event_t ev = {.type = UI_EV_OWNER, .len = sizeof(const owner_info_t *)};
    const owner_info_t *p = lost.on ? &lost.shown : &owner; /* lost mode shows what the owner chose */
    memcpy(ev.data, &p, sizeof p);
    ui_handle_event(&ev);
    if (lost.on) {
        ui_event_t lev = {.type = UI_EV_LOST, .len = 1, .data = {1}};
        ui_handle_event(&lev);
    }
}

/* A dead panel or UI task is not fixed by rebooting: log it once and idle instead of looping through
 * panics and coredump writes. */
static void halt(const char *what, esp_err_t err)
{
    ESP_LOGE(TAG, "%s failed: %s (idle)", what, esp_err_to_name(err));
    for (;;) vTaskDelay(portMAX_DELAY);
}

void app_main(void)
{
    ESP_LOGW(TAG, "Aelys companion fw %s", FW_VERSION);
    ESP_LOGW(TAG, "psram_size=%u free_internal=%u free_spiram=%u", (unsigned)esp_psram_get_size(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    esp_err_t berr = board_init();
    if (berr != ESP_OK) halt("board_init", berr);
    /* Load settings before the UI exists, and apply them inside the ui task right after ui_setup(), so
     * the first frame is already the right screen (no home flash before lost mode). Empty or corrupt
     * NVS gives the factory contacts and lost mode off; never a crash or a reboot. */
    esp_err_t nerr = store_init();
    if (nerr != ESP_OK) ESP_LOGE(TAG, "nvs: %s (running on defaults)", esp_err_to_name(nerr));
    store_load_owner(&owner);
    store_load_lost(&lost);
    ESP_LOGW(TAG, "boot: lost_mode=%s", lost.on ? "on" : "off");

    lv_port_set_handler(ui_handle_event);
    berr = lv_port_start(boot_ui_setup);
    if (berr != ESP_OK) halt("ui start", berr);

    esp_err_t err = board_input_start();
    if (err != ESP_OK) ESP_LOGE(TAG, "input start: %s", esp_err_to_name(err));

#ifndef CONFIG_AELYS_NO_WIFI
    static const net_store_t nstore = {.load = store_load_wifi, .save = store_save_wifi};
    err = net_start(&nstore);
    if (err != ESP_OK) ESP_LOGE(TAG, "net start: %s", esp_err_to_name(err));
    ESP_LOGW(TAG, "wifi started: free_internal=%u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
#endif

    metrics_start(CONFIG_AELYS_METRICS_PERIOD_S);
}
