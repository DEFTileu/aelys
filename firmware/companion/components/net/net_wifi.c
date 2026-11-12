#include <stdlib.h>
#include <string.h>
#include "board.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "net.h"
#include "net_priv.h"
#include "ui_events.h"

#define BIT_IP   BIT0
#define BIT_DISC BIT1
#define ATTEMPT_TIMEOUT_MS 15000 /* a wrong password must show within this */
#define BACKOFF_MIN_MS 1000
#define BACKOFF_MAX_MS 60000

typedef enum { R_OK, R_BAD_PASSWORD, R_FAIL, R_ABORT } result_t;

static const char *TAG = "net";
static EventGroupHandle_t evg;
static volatile bool link_up;           /* IP held; written by the event handler */
static volatile uint8_t disc_reason;
static net_store_t store;

/* everything below is touched by the net task only */
static wifi_list_t saved;
static size_t idx;                      /* network being tried / in use */
static bool online;
static int64_t next_try_us;
static uint32_t backoff_ms = BACKOFF_MIN_MS;
static bool attempting, abort_req;
static uint8_t want_state = UI_WIFI_OFFLINE, posted_state = 0xFF;

void net_set_wifi_state(uint8_t s) { want_state = s; }
bool net_wifi_online(void) { return online; }
bool net_wifi_busy(void) { return attempting; }
void net_wifi_abort(void) { abort_req = true; }

void net_housekeeping(void)
{
    net_time_tick();
    if (want_state != posted_state) {
        ui_event_t ev = {.type = UI_EV_WIFI, .len = 1, .data = {want_state}};
        if (lv_port_post(&ev)) posted_state = want_state;
    }
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        disc_reason = ((wifi_event_sta_disconnected_t *)data)->reason;
        link_up = false;
        xEventGroupClearBits(evg, BIT_IP);
        xEventGroupSetBits(evg, BIT_DISC);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        link_up = true;
        xEventGroupSetBits(evg, BIT_IP);
    }
}

static bool is_bad_password(uint8_t r)
{
    return r == WIFI_REASON_AUTH_FAIL || r == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT ||
           r == WIFI_REASON_HANDSHAKE_TIMEOUT || r == WIFI_REASON_MIC_FAILURE;
}

static result_t attempt_inner(const char *ssid, const char *pass);

/* One blocking connection attempt (<= ATTEMPT_TIMEOUT_MS). Shows CONNECTING, then the outcome.
 * Keeps Improv answering while it waits. */
static result_t attempt(const char *ssid, const char *pass)
{
    attempting = true;
    abort_req = false;
    result_t r = attempt_inner(ssid, pass);
    attempting = false;
    return r;
}

static result_t attempt_inner(const char *ssid, const char *pass)
{
    if (link_up) { /* leaving a working link: wait for its disconnect event so it is not mistaken for ours */
        esp_wifi_disconnect();
        xEventGroupWaitBits(evg, BIT_DISC, pdTRUE, pdFALSE, pdMS_TO_TICKS(1000));
    }
    xEventGroupClearBits(evg, BIT_IP | BIT_DISC);

    wifi_config_t c = {0};
    memcpy(c.sta.ssid, ssid, strlen(ssid)); /* 32 bytes max, no NUL needed */
    strlcpy((char *)c.sta.password, pass, sizeof c.sta.password);
    c.sta.threshold.authmode = pass[0] ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN; /* no downgrade to an open twin */
    c.sta.pmf_cfg.capable = true;
    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &c);
    explicit_bzero(&c, sizeof c);
    if (err == ESP_OK) err = esp_wifi_connect();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "connect: %s", esp_err_to_name(err));
        net_set_wifi_state(UI_WIFI_OFFLINE);
        return R_FAIL;
    }
    net_set_wifi_state(UI_WIFI_CONNECTING);

    int64_t end = esp_timer_get_time() + ATTEMPT_TIMEOUT_MS * 1000LL;
    for (;;) {
        net_improv_poll(); /* paces the loop (10 ms read) */
        net_housekeeping();
        EventBits_t b = xEventGroupWaitBits(evg, BIT_IP | BIT_DISC, pdFALSE, pdFALSE, 0);
        if (b & BIT_IP) { net_set_wifi_state(UI_WIFI_ONLINE); return R_OK; }
        if (b & BIT_DISC) {
            bool bad = is_bad_password(disc_reason);
            ESP_LOGW(TAG, "attempt failed, reason %u%s", disc_reason, bad ? " (password)" : "");
            net_set_wifi_state(bad ? UI_WIFI_BAD_PASSWORD : UI_WIFI_OFFLINE);
            return bad ? R_BAD_PASSWORD : R_FAIL;
        }
        if (abort_req || esp_timer_get_time() > end) {
            if (abort_req) ESP_LOGW(TAG, "attempt replaced by a new request");
            else ESP_LOGW(TAG, "attempt timed out");
            esp_wifi_disconnect();
            xEventGroupWaitBits(evg, BIT_DISC, pdTRUE, pdFALSE, pdMS_TO_TICKS(500));
            net_set_wifi_state(UI_WIFI_OFFLINE);
            return abort_req ? R_ABORT : R_FAIL;
        }
    }
}

static void went_online(void)
{
    online = true;
    backoff_ms = BACKOFF_MIN_MS;
    net_time_start();
    ESP_LOGI(TAG, "online (network %u)", (unsigned)idx);
}

bool net_wifi_provision(const char *ssid, const char *pass)
{
    online = false;
    if (attempt(ssid, pass) != R_OK) {
        next_try_us = esp_timer_get_time(); /* back to the saved networks right away */
        backoff_ms = BACKOFF_MIN_MS;
        return false;
    }
    /* Only a network that connected is ever stored. It becomes the active one in RAM even if the
     * NVS write fails, so the reported success and the reconnect target agree. */
    if (wifi_list_upsert(&saved, ssid, pass)) {
        for (size_t i = 0; i < saved.n; i++)
            if (!strcmp(saved.net[i].ssid, ssid)) idx = i;
        esp_err_t err = store.save(&saved);
        if (err != ESP_OK) ESP_LOGE(TAG, "saving the network failed: %s (kept in RAM only)", esp_err_to_name(err));
    } else {
        ESP_LOGE(TAG, "network not added to the saved list");
    }
    went_online();
    return true;
}

static void net_task(void *arg)
{
    for (;;) {
        net_improv_poll(); /* ~10 ms blocking read */
        net_housekeeping();
        int64_t now = esp_timer_get_time();
        if (online) {
            if (!link_up) { /* dropped: retry the same network at once, then back off */
                ESP_LOGW(TAG, "link lost, reason %u", disc_reason);
                online = false;
                net_set_wifi_state(UI_WIFI_OFFLINE);
                next_try_us = now;
            }
        } else if (saved.n > 0 && now >= next_try_us) {
            if (idx >= saved.n) idx = 0;
            size_t tried = 0;
            result_t r = R_FAIL;
            while (tried < saved.n && (r = attempt(saved.net[idx].ssid, saved.net[idx].pass)) != R_OK &&
                   r != R_ABORT) {
                idx = (idx + 1) % saved.n; /* next saved network straight away; back off after a full round */
                tried++;
            }
            if (r == R_OK) {
                went_online();
            } else if (r != R_ABORT) {
                uint32_t delay = backoff_ms * 3 / 4 + esp_random() % (backoff_ms / 2 + 1); /* 75..125 % */
                next_try_us = esp_timer_get_time() + (int64_t)delay * 1000;
                ESP_LOGI(TAG, "offline, retry in %u ms", (unsigned)delay);
                backoff_ms = backoff_ms * 2 > BACKOFF_MAX_MS ? BACKOFF_MAX_MS : backoff_ms * 2;
            }
        }
        net_improv_run_pending();
    }
}

esp_err_t net_start(const net_store_t *s)
{
    store = *s;
    store.load(&saved);

    evg = xEventGroupCreate();
    if (!evg) return ESP_ERR_NO_MEM;
    ESP_ERROR_CHECK(esp_netif_init());
    esp_err_t err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM)); /* credentials live in our NVS blob only */
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_MIN_MODEM));
    ESP_ERROR_CHECK(esp_wifi_start());

    err = net_improv_init();
    if (err != ESP_OK) ESP_LOGE(TAG, "improv listener: %s", esp_err_to_name(err));
    if (xTaskCreatePinnedToCore(net_task, "net", 8192, NULL, 5, NULL, 0) != pdPASS) return ESP_ERR_NO_MEM;
    return ESP_OK;
}
