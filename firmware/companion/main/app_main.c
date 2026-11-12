#include <string.h>

#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "owner.h"
#include "ui.h"

#define FW_VERSION "0.1.0"

static const char *TAG = "companion";

/* The ui copies this on receipt; the NVS-backed owner data replaces it in a later task. */
static owner_info_t owner;

void app_main(void)
{
    ESP_LOGW(TAG, "Aelys companion fw %s", FW_VERSION);
    ESP_LOGW(TAG, "psram_size=%u free_internal=%u free_spiram=%u", (unsigned)esp_psram_get_size(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    ESP_ERROR_CHECK(board_init());
    lv_port_set_handler(ui_handle_event);
    ESP_ERROR_CHECK(lv_port_start(ui_setup));

    owner_defaults(&owner);
    ui_event_t ev = {.type = UI_EV_OWNER, .len = sizeof(const owner_info_t *)};
    const owner_info_t *p = &owner;
    memcpy(ev.data, &p, sizeof p);
    lv_port_post(&ev);

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
