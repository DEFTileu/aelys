#include <stdatomic.h>
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
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "net.h"
#include "net_priv.h"
#include "ui_events.h"

#define BIT_IP   BIT0
#define BIT_DISC BIT1
#define BIT_SCAN BIT2
#define SCAN_MAX_MS 4000
#define SCAN_RECORDS 24
#define REQ_WAIT_MS 6000 /* how long a caller waits for the net task to pick a request up before withdrawing it */
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
static char cur_ssid[33];               /* the network in use ("" offline); written by the net task, read via net_wifi_current_ssid */

/* Requests from other tasks (the link task). The net task owns Wi-Fi, so a scan, a connection attempt or a list edit is handed over
 * here and run in the net task's own loop, one at a time; the caller blocks until it is done. */
typedef enum { RQ_SCAN, RQ_TRY, RQ_REMOVE, RQ_ORDER } rq_kind_t;
static struct {
    rq_kind_t kind;
    char ssid[33], pass[65];
    char order[WIFI_MAX][33];
    int n;                              /* order: names; scan: capacity of out */
    wifi_seen_t *out;
    int result;                         /* scan: count or -1; others: 1 done, 0 nothing to change, -1 failed */
} rq;
static SemaphoreHandle_t rq_mu, rq_done;
static atomic_bool rq_pending;          /* set by the caller once rq is filled; cleared by whoever takes it (net task or the caller withdrawing) */

void net_set_wifi_state(uint8_t s) { want_state = s; }
bool net_wifi_online(void) { return online; }
const char *net_wifi_current_ssid(void) { return cur_ssid; }
bool net_lost_on(void) { return !store.lost_on || store.lost_on(); }
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
    if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        xEventGroupSetBits(evg, BIT_SCAN);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
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
        if (abort_req || atomic_load(&rq_pending) || esp_timer_get_time() > end) { /* a request from another task replaces the attempt too */
            if (!abort_req && atomic_load(&rq_pending)) abort_req = true;
            if (abort_req) ESP_LOGW(TAG, "attempt replaced by a new request");
            else ESP_LOGW(TAG, "attempt timed out");
            esp_wifi_disconnect();
            xEventGroupWaitBits(evg, BIT_DISC, pdTRUE, pdFALSE, pdMS_TO_TICKS(500));
            net_set_wifi_state(UI_WIFI_OFFLINE);
            return abort_req ? R_ABORT : R_FAIL;
        }
    }
}

static void went_online(const char *ssid)
{
    strlcpy(cur_ssid, ssid, sizeof cur_ssid);
    online = true;
    backoff_ms = BACKOFF_MIN_MS;
    net_time_start();
    ESP_LOGI(TAG, "online (network %u)", (unsigned)idx);
}

bool net_wifi_provision(const char *ssid, const char *pass)
{
    online = false;
    cur_ssid[0] = '\0';
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
    went_online(ssid);
    return true;
}

/* ---- requests (net task side) ---- */

/* Active scan of all channels, bounded by SCAN_MAX_MS; the station keeps its connection. */
static int run_scan(wifi_seen_t *out, int max)
{
    wifi_scan_config_t c = {.show_hidden = false, .scan_type = WIFI_SCAN_TYPE_ACTIVE, .scan_time.active = {.min = 100, .max = 150}};
    xEventGroupClearBits(evg, BIT_SCAN);
    if (esp_wifi_scan_start(&c, false) != ESP_OK) return -1;
    if (!(xEventGroupWaitBits(evg, BIT_SCAN, pdTRUE, pdFALSE, pdMS_TO_TICKS(SCAN_MAX_MS)) & BIT_SCAN)) {
        esp_wifi_scan_stop();
        esp_wifi_clear_ap_list();
        ESP_LOGW(TAG, "scan timed out");
        return -1;
    }
    uint16_t n = 0;
    esp_wifi_scan_get_ap_num(&n);
    if (n > SCAN_RECORDS) n = SCAN_RECORDS;
    wifi_ap_record_t *ap = calloc(n ? n : 1, sizeof *ap);
    wifi_seen_t *v = calloc(n ? n : 1, sizeof *v);
    int k = -1;
    if (ap && v && esp_wifi_scan_get_ap_records(&n, ap) == ESP_OK) { /* also frees the driver's list */
        for (int i = 0; i < n; i++) {
            strlcpy(v[i].ssid, (const char *)ap[i].ssid, sizeof v[i].ssid);
            v[i].rssi = ap[i].rssi;
            v[i].secure = ap[i].authmode != WIFI_AUTH_OPEN;
        }
        k = wifi_seen_merge(v, n, max);
        memcpy(out, v, (size_t)k * sizeof *out);
    } else {
        esp_wifi_clear_ap_list();
    }
    free(ap);
    free(v);
    return k;
}

/* remove or reorder: edit a copy, persist it, and only then adopt it, so RAM and flash never disagree. 1 changed, 0 nothing to do, -1 not saved */
static int run_edit(bool remove)
{
    wifi_list_t next = saved;
    char cur[33] = "";
    if (idx < saved.n) strlcpy(cur, saved.net[idx].ssid, sizeof cur);
    bool changed = remove ? wifi_list_remove(&next, rq.ssid) : wifi_list_reorder(&next, (const char(*)[33])rq.order, rq.n);
    int r = 0;
    if (changed) {
        if (store.save(&next) != ESP_OK) {
            ESP_LOGE(TAG, "saving the network list failed");
            r = -1;
        } else {
            saved = next;
            size_t i = 0;
            while (i < saved.n && strcmp(saved.net[i].ssid, cur) != 0) i++;
            idx = i; /* keeps pointing at the network in use; a removed one wraps to the first */
            r = 1;
        }
    }
    explicit_bzero(&next, sizeof next);
    return r;
}

static void rq_run(void)
{
    bool expected = true;
    if (!atomic_compare_exchange_strong(&rq_pending, &expected, false)) return; /* nothing, or the caller withdrew it */
    switch (rq.kind) {
    case RQ_SCAN: rq.result = run_scan(rq.out, rq.n); break;
    case RQ_TRY: rq.result = net_wifi_provision(rq.ssid, rq.pass) ? 1 : -1; break;
    case RQ_REMOVE: rq.result = run_edit(true); break;
    case RQ_ORDER: rq.result = run_edit(false); break;
    }
    explicit_bzero(rq.pass, sizeof rq.pass);
    xSemaphoreGive(rq_done);
}

/* ---- requests (caller side) ---- */

/* One request at a time: rq_begin takes the slot (the caller then fills rq), rq_finish hands it to the net task and waits. */
static bool rq_begin(void)
{
    return rq_mu && evg && xSemaphoreTake(rq_mu, pdMS_TO_TICKS(100)) == pdTRUE;
}

/* -2: the net task never picked it up (nothing ran). Otherwise rq.result. Wipes the password and releases the slot. */
static int rq_finish(uint32_t run_ms)
{
    xSemaphoreTake(rq_done, 0);
    rq.result = -2;
    atomic_store(&rq_pending, true);
    if (xSemaphoreTake(rq_done, pdMS_TO_TICKS(REQ_WAIT_MS)) != pdTRUE) {
        bool expected = true;
        if (atomic_compare_exchange_strong(&rq_pending, &expected, false)) { /* still ours: withdraw it */
            explicit_bzero(rq.pass, sizeof rq.pass);
            xSemaphoreGive(rq_mu);
            return -2;
        }
        xSemaphoreTake(rq_done, pdMS_TO_TICKS(run_ms)); /* it is running: bounded by its own timeouts */
    }
    int r = rq.result;
    explicit_bzero(rq.pass, sizeof rq.pass);
    xSemaphoreGive(rq_mu);
    return r;
}

int net_wifi_scan(wifi_seen_t *out, int max)
{
    if (!out || max <= 0 || !rq_begin()) return -1;
    rq.kind = RQ_SCAN;
    rq.out = out;
    rq.n = max;
    int r = rq_finish(SCAN_MAX_MS + 1000);
    return r < 0 ? -1 : r;
}

bool net_wifi_try(const char *ssid, const char *pass)
{
    if (!ssid || !pass || !*ssid || strlen(ssid) > 32 || strlen(pass) > 64 || !rq_begin()) return false;
    rq.kind = RQ_TRY;
    strlcpy(rq.ssid, ssid, sizeof rq.ssid);
    strlcpy(rq.pass, pass, sizeof rq.pass);
    return rq_finish(ATTEMPT_TIMEOUT_MS + 3000) == 1;
}

bool net_wifi_remove(const char *ssid)
{
    if (!ssid || !*ssid || strlen(ssid) > 32 || !rq_begin()) return false;
    rq.kind = RQ_REMOVE;
    strlcpy(rq.ssid, ssid, sizeof rq.ssid);
    return rq_finish(2000) >= 0;
}

bool net_wifi_reorder(const char ssids[][33], int n)
{
    if (!ssids || n < 0 || n > WIFI_MAX || !rq_begin()) return false;
    rq.kind = RQ_ORDER;
    memset(rq.order, 0, sizeof rq.order);
    for (int i = 0; i < n; i++) strlcpy(rq.order[i], ssids[i], sizeof rq.order[i]);
    rq.n = n;
    return rq_finish(2000) >= 0;
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
                cur_ssid[0] = '\0';
                net_set_wifi_state(UI_WIFI_OFFLINE);
                next_try_us = now;
            }
        } else if (saved.n > 0 && now >= next_try_us && !atomic_load(&rq_pending)) {
            if (idx >= saved.n) idx = 0;
            size_t tried = 0;
            result_t r = R_FAIL;
            while (tried < saved.n && !abort_req && (r = attempt(saved.net[idx].ssid, saved.net[idx].pass)) != R_OK &&
                   r != R_ABORT) {
                idx = (idx + 1) % saved.n; /* next saved network straight away; back off after a full round */
                tried++;
            }
            if (r == R_OK) {
                went_online(saved.net[idx].ssid);
            } else if (r != R_ABORT) {
                uint32_t delay = backoff_ms * 3 / 4 + esp_random() % (backoff_ms / 2 + 1); /* 75..125 % */
                next_try_us = esp_timer_get_time() + (int64_t)delay * 1000;
                ESP_LOGI(TAG, "offline, retry in %u ms", (unsigned)delay);
                backoff_ms = backoff_ms * 2 > BACKOFF_MAX_MS ? BACKOFF_MAX_MS : backoff_ms * 2;
            }
        }
        net_improv_run_pending();
        rq_run();
    }
}

esp_err_t net_start(const net_store_t *s)
{
    store = *s;
    store.load(&saved);

    evg = xEventGroupCreate();
    if (!evg) return ESP_ERR_NO_MEM;
    esp_err_t err = esp_netif_init();
    if (err != ESP_OK) goto fail_evg;
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) goto fail_evg;
    esp_netif_t *sta = esp_netif_create_default_wifi_sta();
    if (!sta) { err = ESP_FAIL; goto fail_evg; }
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK) goto fail_netif;
    err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    if (err != ESP_OK) goto fail_wifi;
    err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL);
    if (err != ESP_OK) goto fail_h1;
    /* credentials live in our NVS blob only */
    if ((err = esp_wifi_set_storage(WIFI_STORAGE_RAM)) != ESP_OK || (err = esp_wifi_set_mode(WIFI_MODE_STA)) != ESP_OK ||
        (err = esp_wifi_set_ps(WIFI_PS_MIN_MODEM)) != ESP_OK || (err = esp_wifi_start()) != ESP_OK)
        goto fail_h2;

    err = net_improv_init();
    if (err != ESP_OK) ESP_LOGE(TAG, "improv listener: %s", esp_err_to_name(err));
    rq_mu = xSemaphoreCreateMutex();
    rq_done = xSemaphoreCreateBinary();
    if (!rq_mu || !rq_done || xTaskCreatePinnedToCore(net_task, "net", 8192, NULL, 5, NULL, 0) != pdPASS) {
        err = ESP_ERR_NO_MEM;
        if (rq_mu) { vSemaphoreDelete(rq_mu); rq_mu = NULL; }
        if (rq_done) { vSemaphoreDelete(rq_done); rq_done = NULL; }
        goto fail_h2;
    }
    return ESP_OK;

/* Wi-Fi is optional: undo what was set up so the caller can log the error and carry on without it. */
fail_h2:
    esp_wifi_stop();
    esp_event_handler_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event);
fail_h1:
    esp_event_handler_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event);
fail_wifi:
    esp_wifi_deinit();
fail_netif:
    esp_netif_destroy_default_wifi(sta);
fail_evg:
    vEventGroupDelete(evg);
    evg = NULL;
    return err;
}
