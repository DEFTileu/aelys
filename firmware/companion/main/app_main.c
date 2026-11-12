#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"

#define FW_VERSION "0.1.0"

static const char *TAG = "companion";

void app_main(void)
{
    ESP_LOGW(TAG, "Aelys companion fw %s", FW_VERSION);
    ESP_LOGW(TAG, "psram_size=%u free_internal=%u free_spiram=%u",
             (unsigned)esp_psram_get_size(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}
