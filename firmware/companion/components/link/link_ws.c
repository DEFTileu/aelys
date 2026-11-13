/* The wss:// channel: one esp_websocket_client per attempt (auto-reconnect off, the link FSM drives it). Its task runs
 * the callback below: it only assembles frames into a free PSRAM slot and posts to the link task; it never waits for it
 * (the client holds its lock while a callback runs, so waiting on a task that wants to send would deadlock). */
#include <stdio.h>
#include <string.h>
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "link_priv.h"

#define WS_TASK_NAME "ws_link"
#define WS_STACK 6144

static const char *TAG = "link";

enum { OP_CONT = 0x0, OP_TEXT = 0x1, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA };

static struct {
    esp_websocket_client_handle_t client;
    volatile uint32_t gen;        /* 0 = no socket */
    uint32_t next_gen;
    volatile uint32_t last_rx_ms;
    volatile bool lost_frame;     /* a frame was dropped for this socket: the link task closes it (tick), so the reconnect's hello resends what is pending */
    /* below: written by the ws task only (for the current gen) */
    int slot;                     /* slot being filled, -1 none */
    size_t len;
    bool drop;
    int close_code;
    int hs_status;
    uint32_t closed_gen;
    /* shared */
    volatile bool busy[LINK_RX_SLOTS];
    uint32_t stack_min;
} ws = { .slot = -1 };

static SemaphoreHandle_t mu; /* the client pointer vs send/close */

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

uint32_t link_ws_gen(void) { return ws.gen; }
uint32_t link_ws_last_rx_ms(void) { return ws.last_rx_ms; }
bool link_ws_lost_frame(void) { return ws.gen && ws.lost_frame; }
uint32_t link_ws_stack_free_min(void) { return ws.stack_min; }
void link_ws_slot_free(int slot) { if (slot >= 0 && slot < LINK_RX_SLOTS) ws.busy[slot] = false; }

static int claim_slot(void)
{
    for (int i = 0; i < LINK_RX_SLOTS; i++)
        if (!ws.busy[i]) { ws.busy[i] = true; return i; }
    return -1;
}

static void on_data(uint32_t gen, const esp_websocket_event_data_t *e)
{
    ws.last_rx_ms = now_ms();
    int op = e->op_code;
    if (op == OP_CLOSE) { /* the status code is the first two bytes; CLOSED/DISCONNECTED follows */
        if (e->data_len >= 2) ws.close_code = ((uint8_t)e->data_ptr[0] << 8) | (uint8_t)e->data_ptr[1];
        return;
    }
    if (op != OP_TEXT && op != OP_CONT) return; /* ping, pong, binary: not part of the protocol */
    if (op == OP_TEXT && e->payload_offset == 0) { /* a new message: forget a half-built one */
        if (ws.slot >= 0) ws.busy[ws.slot] = false;
        ws.slot = claim_slot();
        ws.len = 0;
        ws.drop = ws.slot < 0;
        if (ws.drop) { ESP_LOGW(TAG, "frame dropped: no free buffer"); ws.lost_frame = true; }
    }
    if (ws.slot < 0 && !ws.drop) return; /* a continuation without a start */
    if (!ws.drop) {
        if (ws.len + (size_t)e->data_len > LINK_FRAME_MAX) {
            ESP_LOGW(TAG, "frame dropped: over %d bytes", LINK_FRAME_MAX);
            ws.drop = true;
            ws.busy[ws.slot] = false;
            ws.slot = -1;
        } else {
            memcpy(link_mem->rx[ws.slot] + ws.len, e->data_ptr, (size_t)e->data_len);
            ws.len += (size_t)e->data_len;
        }
    }
    if (e->fin && e->payload_offset + e->data_len >= e->payload_len) { /* message complete */
        if (!ws.drop && ws.slot >= 0) {
            link_mem->rx[ws.slot][ws.len] = '\0';
            if (!link_q_post(LQ_WS_FRAME, gen, ws.slot, (int32_t)ws.len)) { ws.busy[ws.slot] = false; ws.lost_frame = true; }
        }
        ws.slot = -1;
        ws.len = 0;
        ws.drop = false;
    }
}

static void closed(uint32_t gen, int code)
{
    if (ws.closed_gen == gen) return; /* DISCONNECTED and CLOSED can both fire */
    ws.closed_gen = gen;
    if (code == 0) code = ws.close_code;
    if (code == 0) code = ws.hs_status == 401 ? 4401 : ws.hs_status == 403 ? 4403 : 0; /* refused before the upgrade */
    link_q_post(LQ_WS_CLOSED, gen, code, 0);
}

static void on_ws(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)base;
    uint32_t gen = (uint32_t)(uintptr_t)arg;
    if (gen != ws.gen) return; /* an older socket, already torn down */
    const esp_websocket_event_data_t *e = data;
    switch (id) {
    case WEBSOCKET_EVENT_ERROR:
        ws.hs_status = e->error_handle.esp_ws_handshake_status_code;
        if (e->error_handle.error_type == WEBSOCKET_ERROR_TYPE_TCP_TRANSPORT && e->error_handle.esp_tls_stack_err != 0)
            link_tls_failed();
        ESP_LOGW(TAG, "ws error type=%d hs=%d tls=%d", (int)e->error_handle.error_type, e->error_handle.esp_ws_handshake_status_code,
                 e->error_handle.esp_tls_stack_err);
        break;
    case WEBSOCKET_EVENT_DATA:
        on_data(gen, e);
        break;
    case WEBSOCKET_EVENT_CLOSED:
    case WEBSOCKET_EVENT_DISCONNECTED:
        closed(gen, e->close_status_code);
        break;
    default:
        break;
    }
}

uint32_t link_ws_open(const char *api_url, const char *token)
{
    if (!mu && !(mu = xSemaphoreCreateMutex())) return 0;
    char uri[200];
    if (strncmp(api_url, "https://", 8) != 0 || snprintf(uri, sizeof uri, "wss://%s/devices/channel", api_url + 8) >= (int)sizeof uri) return 0;
    /* the header goes in the (idle) tx buffer; the client copies it, then it is wiped */
    if (snprintf(link_mem->tx, sizeof link_mem->tx, "Authorization: Bearer %s\r\n", token) >= (int)sizeof link_mem->tx) {
        explicit_bzero(link_mem->tx, sizeof link_mem->tx); /* a cut header still starts with the token */
        return 0;
    }
    esp_websocket_client_config_t cfg = {
        .uri = uri,
        .headers = link_mem->tx,
        .transport = WEBSOCKET_TRANSPORT_OVER_SSL,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_reconnect = true,
        .task_name = WS_TASK_NAME,
        .task_stack = WS_STACK,
        .task_prio = 5,
        .task_core_id_set = true,
        .task_core_id = 0,
        .buffer_size = 1024,
        .network_timeout_ms = 10000,
        .ping_interval_sec = 30,
        .disable_pingpong_discon = true, /* the link task closes a socket that is silent for 75 s */
    };
    esp_websocket_client_handle_t c = esp_websocket_client_init(&cfg);
    explicit_bzero(link_mem->tx, sizeof link_mem->tx);
    if (!c) return 0;
    if (++ws.next_gen == 0) ws.next_gen = 1; /* 0 means no socket */
    uint32_t gen = ws.next_gen;
    ws.slot = -1; ws.len = 0; ws.drop = false; ws.close_code = 0; ws.hs_status = 0; ws.lost_frame = false;
    ws.last_rx_ms = now_ms();
    ws.gen = gen;
    if (esp_websocket_register_events(c, WEBSOCKET_EVENT_ANY, on_ws, (void *)(uintptr_t)gen) != ESP_OK ||
        esp_websocket_client_start(c) != ESP_OK) {
        ws.gen = 0;
        esp_websocket_client_destroy(c);
        return 0;
    }
    xSemaphoreTake(mu, portMAX_DELAY);
    ws.client = c;
    xSemaphoreGive(mu);
    return gen;
}

void link_ws_close(void)
{
    if (!mu) return;
    xSemaphoreTake(mu, portMAX_DELAY);
    esp_websocket_client_handle_t c = ws.client;
    ws.client = NULL;
    ws.gen = 0; /* its callbacks are stale from here on */
    ws.lost_frame = false;
    xSemaphoreGive(mu);
    if (!c) return;
    TaskHandle_t t = xTaskGetHandle(WS_TASK_NAME);
    if (t) {
        uint32_t f = uxTaskGetStackHighWaterMark(t);
        if (ws.stack_min == 0 || f < ws.stack_min) ws.stack_min = f;
    }
    esp_websocket_client_destroy(c); /* stops its task (up to a network timeout while a connect is running) */
    for (int i = 0; i < LINK_RX_SLOTS; i++) ws.busy[i] = false; /* frames of the dead socket are dropped by their generation */
    ws.slot = -1;
}

bool link_ws_send(const char *json, size_t n)
{
    if (!mu) return false;
    xSemaphoreTake(mu, portMAX_DELAY);
    esp_websocket_client_handle_t c = ws.client;
    int r = -1;
    if (c && esp_websocket_client_is_connected(c)) r = esp_websocket_client_send_text(c, json, (int)n, pdMS_TO_TICKS(2000));
    xSemaphoreGive(mu);
    if (r != (int)n) ESP_LOGW(TAG, "ws send failed (%d of %u)", r, (unsigned)n);
    return r == (int)n;
}
