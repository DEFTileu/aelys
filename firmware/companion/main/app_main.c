#include <string.h>

#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "owner.h"
#include "store_nvs.h"
#include "ui.h"

#define FW_VERSION "0.1.0"

static const char *TAG = "companion";

/* The ui copies from these on receipt, so they must stay valid until it has drained the queue. */
static owner_info_t owner;
static lost_state_t lost;

void app_main(void)
{
    ESP_LOGW(TAG, "Aelys companion fw %s", FW_VERSION);
    ESP_LOGW(TAG, "psram_size=%u free_internal=%u free_spiram=%u", (unsigned)esp_psram_get_size(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    ESP_ERROR_CHECK(board_init());
    lv_port_set_handler(ui_handle_event);
    ESP_ERROR_CHECK(lv_port_start(ui_setup));

    /* Empty or corrupt NVS gives the factory contacts and lost mode off; never a crash or a reboot. */
    esp_err_t nerr = store_init();
    if (nerr != ESP_OK) ESP_LOGE(TAG, "nvs: %s (running on defaults)", esp_err_to_name(nerr));
    store_load_owner(&owner);
    store_load_lost(&lost);
    ESP_LOGW(TAG, "boot: lost_mode=%s", lost.on ? "on" : "off");

    ui_event_t ev = {.type = UI_EV_OWNER, .len = sizeof(const owner_info_t *)};
    const owner_info_t *p = lost.on ? &lost.shown : &owner; /* lost mode shows what the owner chose */
    memcpy(ev.data, &p, sizeof p);
    lv_port_post(&ev);
    if (lost.on) {
        ui_event_t lev = {.type = UI_EV_LOST, .len = 1, .data = {1}};
        lv_port_post(&lev);
    }

    esp_err_t err = board_input_start();
    if (err != ESP_OK) ESP_LOGE(TAG, "input start: %s", esp_err_to_name(err));

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        uint32_t fps_x10, worst_us;
        lv_port_frame_stats(&fps_x10, &worst_us);
        ESP_LOGI(TAG, "fps_x10=%u worst_us=%u free_internal=%u", (unsigned)fps_x10, (unsigned)worst_us,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    }
}
