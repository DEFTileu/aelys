#include <stdlib.h>
#include <time.h>
#include "board.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "net_priv.h"
#include "ui_events.h"

static const char *TAG = "net_time";
static bool started;
static int last_min = -1;

void net_time_start(void)
{
    if (started) return;
    setenv("TZ", CONFIG_AELYS_TZ, 1);
    tzset();
    esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    if (esp_netif_sntp_init(&cfg) != ESP_OK) { ESP_LOGE(TAG, "sntp init failed"); return; }
    started = true;
}

void net_time_tick(void)
{
    time_t now = time(NULL);
    struct tm t;
    localtime_r(&now, &t);
    if (t.tm_year < 124) return; /* before 2024: the clock was never set */
    int key = t.tm_hour * 60 + t.tm_min;
    if (key == last_min) return;
    ui_event_t ev = {.type = UI_EV_TIME, .len = 2, .data = {(uint8_t)t.tm_hour, (uint8_t)t.tm_min}};
    if (lv_port_post(&ev)) last_min = key;
}
