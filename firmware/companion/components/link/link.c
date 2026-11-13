/* The `link` task: sign in by device signature, keep the wss:// channel, publish snapshots and actions.
 * link_fsm decides; this file runs its actions and feeds the results back. Every socket and request is tagged with a
 * generation, so events of a dead one are dropped. A pairing is wiped only on LE_CHALLENGE_UNKNOWN while checking
 * (a 401 UNAUTHORIZED from /auth/device/challenge); every other failure only backs off. */
#include <stdio.h>
#include <stdatomic.h>
#include <string.h>
#include <time.h>
#include "board.h"
#include "codec_util.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "identity.h"
#include "link_core.h"
#include "link_fsm.h"
#include "link_priv.h"
#include "sdkconfig.h"
#include "tribuf.h"
#include "ui.h"
#include "ui_events.h"

#ifndef CONFIG_AELYS_LINK_CHAOS_S
#define CONFIG_AELYS_LINK_CHAOS_S 0
#endif

#define LINK_STACK 8192        /* brief: >= 6 KB. esp_http_client's TLS handshake runs on it too; trim to the measured high-water mark */
#define HB_MS 30000u           /* heartbeat */
#define METRICS_MS 300000u     /* spec section 4.6 */
#define SILENCE_MS 75000u      /* no frame at all: the socket is dead */
#define READY_MS 15000u        /* from the connect action to the server's `ready` */
#define HEAP_NEED 16384u       /* largest internal block before a TLS connect */
#define NO_EVENT (-1)
#define CLOCK_SET_MIN 1735689600 /* 2025-01-01: any earlier time means SNTP has not run */

typedef struct { uint8_t kind; uint32_t gen; int32_t a, b; } lq_t;

static const char *TAG = "link";

link_mem_t *link_mem;
link_deps_t link_deps;

static QueueHandle_t q;
static SemaphoreHandle_t act_mu;
static link_acts_t acts;
static link_fsm_t fsm;
#ifdef CONFIG_AELYS_PERF_PROBE
static atomic_int probe_state = ATOMIC_VAR_INIT(-1);
#endif
static volatile bool ws_online;
static volatile uint32_t paired_seq;  /* bumped by the net task on every PAIR_COMMIT */
static volatile bool act_queued;
static volatile uint32_t heap_conn_min, tls_fail;
static uint32_t backoff_deadline, connect_deadline, open_ms, last_hb, last_metrics, last_snap_save, net_ups, reconnects;
static bool stable_sent, net_up, snap_dirty, wipe_retry;
static uint32_t seen_seq;             /* paired_seq the task has acted on */
static uint8_t ui_posted;

/* sign-in scratch, link task only (kept off the 6 KB stack, which identity_sign needs 4.3 KB of) */
static struct { char dev[40], url[129], cid[40], nonce[80], msg[160], sig[87]; link_act_t expired[LINK_ACT_MAX]; } ctx;

static uint32_t ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }
static bool due(uint32_t deadline) { return (int32_t)(ms() - deadline) >= 0; }

uint32_t link_heap_at_connect_min(void) { return heap_conn_min; }
uint32_t link_tls_failures(void) { return tls_fail; }
void link_tls_failed(void) { tls_fail++; }

bool link_q_post(lq_kind_t k, uint32_t gen, int32_t a, int32_t b)
{
    if (!q) return false;
    if (k == LQ_ACTION) {
        if (act_queued) return true; /* the pending event will send every waiting action */
        act_queued = true;
    }
    lq_t ev = {.kind = (uint8_t)k, .gen = gen, .a = a, .b = b};
    bool ok = xQueueSend(q, &ev, pdMS_TO_TICKS(50)) == pdTRUE;
    if (!ok && k == LQ_ACTION) act_queued = false;
    return ok;
}

/* ---------------------------------------------------------------- heap rule */

void link_heap_gate(const char *what)
{
    for (int i = 0; i < 20 && heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL) < HEAP_NEED; i++)
        vTaskDelay(pdMS_TO_TICKS(500)); /* <= 10 s, then connect anyway: a failure is counted, not hidden */
    uint32_t fr = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    uint32_t big = (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
    if (heap_conn_min == 0 || fr < heap_conn_min) heap_conn_min = fr;
    ESP_LOGW(TAG, "link connect heap_int=%u largest=%u (%s)", (unsigned)fr, (unsigned)big, what);
}

/* ----------------------------------------------------------------------- ui */

static uint8_t ui_state(link_state_t s)
{
    switch (s) {
    case LS_UNPAIRED: return LINK_UI_UNPAIRED;
    case LS_LOGIN: case LS_CONNECT: case LS_CHECK: return LINK_UI_CONNECTING;
    case LS_ONLINE: return LINK_UI_ONLINE;
    default: return LINK_UI_OFFLINE; /* waiting for Wi-Fi, backing off, replaced by a newer connection */
    }
}

static void ui_post(const ui_event_t *ev)
{
    for (int i = 0; i < 5 && !lv_port_post(ev); i++) vTaskDelay(pdMS_TO_TICKS(10));
}

static void sync_ui(void)
{
    uint8_t v = ui_state(fsm.st);
    if (v == ui_posted) return;
    ui_event_t ev = {.type = UI_EV_LINK, .len = 1, .data = {v}};
    if (lv_port_post(&ev)) ui_posted = v; /* a full queue is retried on the next tick */
}

static void post_action_result(act_kind_t k, bool ok, const char *err)
{
    ui_event_t ev = {.type = UI_EV_ACTION, .len = 26, .data = {(uint8_t)k, ok}};
    strlcpy((char *)&ev.data[2], ok ? "" : (err && *err ? err : "ACTION_FAILED"), 24);
    ui_post(&ev);
}

static void publish_snapshot(const snap_t *s, bool live)
{
    if (!ui_snap_tb.slot[0]) return; /* the UI could not allocate its snapshot buffers */
    memcpy(tribuf_back(&ui_snap_tb), s, sizeof *s);
    tribuf_publish(&ui_snap_tb);
    ui_event_t ev = {.type = UI_EV_SNAPSHOT, .len = 1, .data = {live}};
    ui_post(&ev);
}

/* ------------------------------------------------------------------ sending */

bool link_send_raw(const char *json, size_t n) { return n > 0 && link_ws_send(json, n); }

bool link_send_ack(const char *cmd_id, bool ok, const char *error_code)
{
    char b[160];
    size_t n = proto_command_ack(b, sizeof b, cmd_id, ok, ok ? NULL : error_code);
    return link_send_raw(b, n);
}

/* acks that wait for the channel (wifi_add); link task only */
static struct { char id[40]; bool ok; char code[16]; } held[4];
static int n_held;

void link_queue_ack(const char *cmd_id, bool ok, const char *error_code)
{
    if (n_held == (int)(sizeof held / sizeof held[0])) {
        memmove(&held[0], &held[1], sizeof held - sizeof held[0]);
        n_held--;
    }
    strlcpy(held[n_held].id, cmd_id, sizeof held[0].id);
    held[n_held].ok = ok;
    strlcpy(held[n_held].code, ok || !error_code ? "" : error_code, sizeof held[0].code);
    n_held++;
}

static void flush_acks(void)
{
    int sent = 0;
    while (sent < n_held && link_send_ack(held[sent].id, held[sent].ok, held[sent].code)) sent++;
    n_held -= sent;
    memmove(&held[0], &held[sent], (size_t)n_held * sizeof held[0]); /* what did not go out waits for the next hello */
}

static void send_hello(void)
{
    size_t n = proto_hello(link_mem->tx, sizeof link_mem->tx, esp_app_get_description()->version, "waveshare-amoled-1.75c",
                           link_deps.contact_phone ? link_deps.contact_phone() : NULL,
                           link_deps.contact_telegram ? link_deps.contact_telegram() : NULL);
    link_send_raw(link_mem->tx, n);
    explicit_bzero(link_mem->tx, sizeof link_mem->tx); /* it held the owner's contacts */
}

_Static_assert(sizeof(wifi_list_t) <= LINK_HTTP_MAX, "wifi_state borrows the HTTP buffer");

void link_send_wifi_state(void)
{
    wifi_list_t *l = (wifi_list_t *)link_mem->http; /* idle outside sign-in; only SSIDs go out, the passwords are wiped */
    memset(l, 0, sizeof *l);
    if (link_deps.load_wifi) link_deps.load_wifi(l);
    char cur[33] = "";
    if (link_deps.current_ssid) strlcpy(cur, link_deps.current_ssid(), sizeof cur);
    size_t n = proto_wifi_state(link_mem->tx, sizeof link_mem->tx, l, cur[0] ? cur : NULL);
    explicit_bzero(link_mem->http, LINK_HTTP_MAX);
    link_send_raw(link_mem->tx, n);
}

static void send_metrics(void)
{
    uint8_t pct = 0;
    bool chg = false;
    proto_metrics_t m = {
        .heap_min_internal = (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
        .largest_block = (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
        .psram_free = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        .wifi_reconnects = reconnects,
        .uptime_s = (uint32_t)(esp_timer_get_time() / 1000000),
        .battery_pct = board_battery(&pct, &chg) ? (int8_t)pct : -1,
        .charging = chg,
        .heap_at_connect_min = heap_conn_min,
    };
    link_send_raw(link_mem->tx, proto_metrics(link_mem->tx, sizeof link_mem->tx, &m));
}

static void send_actions(void)
{
    for (;;) {
        xSemaphoreTake(act_mu, portMAX_DELAY);
        const link_act_t *a = link_acts_next_unsent(&acts);
        link_act_t cur;
        if (a) cur = *a;
        xSemaphoreGive(act_mu);
        if (!a) return;
        size_t n = proto_action(link_mem->tx, sizeof link_mem->tx, cur.id, cur.kind, cur.target[0] ? cur.target : NULL, NULL);
        if (!link_send_raw(link_mem->tx, n)) return; /* stays un-sent; expires after 10 s if the socket never comes back */
        xSemaphoreTake(act_mu, portMAX_DELAY);
        link_acts_sent(&acts, cur.id, ms());
        xSemaphoreGive(act_mu);
    }
}

bool link_post_action(act_kind_t k, const char *target_id)
{
    if (!q || !ws_online) return false;
    uint8_t r[16];
    char id[37];
    esp_fill_random(r, sizeof r);
    uuid4_format(r, id);
    xSemaphoreTake(act_mu, portMAX_DELAY);
    bool ok = link_acts_add(&acts, id, k, target_id, ms());
    xSemaphoreGive(act_mu);
    if (ok) link_q_post(LQ_ACTION, 0, 0, 0); /* if the queue is full, tick() sends it within 100 ms anyway */
    return ok;
}

/* ---------------------------------------------------------- sign-in actions */

/* Where the wire result of a sign-in step is turned into an FSM event. */
static link_event_t reject_or_fail(link_http_t h, link_event_t rejected, link_event_t failed)
{
    return h == LH_FAIL ? failed : rejected;
}

/* challenge -> sign -> login. NO_EVENT when a pairing finished meanwhile: the result is for the old identity. */
static int do_login(void)
{
    uint32_t seq = paired_seq;
    if (identity_ids(ctx.dev, ctx.url) != ESP_OK) return LE_LOGIN_FAIL;
    link_heap_gate("challenge");
    link_http_t h = link_http_challenge(ctx.url, ctx.dev, ctx.cid, ctx.nonce);
    if (seq != paired_seq) return NO_EVENT;
    if (h != LH_OK) return reject_or_fail(h, LE_LOGIN_REJECTED, LE_LOGIN_FAIL);
    snprintf(ctx.msg, sizeof ctx.msg, "aelys-device-login-v1\n%s\n%s", ctx.dev, ctx.nonce);
    if (identity_sign(ctx.msg, ctx.sig) != ESP_OK) return LE_LOGIN_FAIL;
    link_heap_gate("login");
    h = link_http_login(ctx.url, ctx.cid, ctx.sig, link_mem->token, LINK_TOKEN_MAX);
    if (seq != paired_seq) { explicit_bzero(link_mem->token, LINK_TOKEN_MAX); return NO_EVENT; }
    if (h == LH_OK) return LE_LOGIN_OK;
    return reject_or_fail(h, LE_LOGIN_REJECTED, LE_LOGIN_FAIL);
}

/* challenge only: does the server still know this device? */
static int do_check(void)
{
    uint32_t seq = paired_seq;
    if (identity_ids(ctx.dev, ctx.url) != ESP_OK) return LE_CHALLENGE_FAIL;
    link_heap_gate("check");
    link_http_t h = link_http_challenge(ctx.url, ctx.dev, ctx.cid, ctx.nonce);
    if (seq != paired_seq) return NO_EVENT;
    return h == LH_OK ? LE_CHALLENGE_OK : h == LH_UNAUTHORIZED ? LE_CHALLENGE_UNKNOWN : LE_CHALLENGE_FAIL;
}

/* opens the socket with the token from the login; true = started (the result comes as LQ_WS_* events) */
static bool do_connect(void)
{
    link_heap_gate("ws");
    uint32_t gen = link_ws_open(ctx.url, link_mem->token);
    explicit_bzero(link_mem->token, LINK_TOKEN_MAX); /* the socket has its own copy of the header */
    connect_deadline = ms() + READY_MS;
    return gen != 0;
}

/* What a wipe leaves behind for the next owner: revisions, cached snapshot (flash and screen). */
static void after_wipe(void)
{
    ESP_LOGW(TAG, "pairing wiped: the server does not know this device");
    n_held = 0; /* acks for the old account's commands */
    if (link_deps.reset_revs) link_deps.reset_revs();
    if (link_deps.erase_snap) link_deps.erase_snap();
    memset(&link_mem->snap, 0, sizeof link_mem->snap);
    link_mem->snap.other_unread = link_mem->snap.today_done = link_mem->snap.today_total = -1;
    snap_dirty = false;
    publish_snapshot(&link_mem->snap, false);
}

/* Forget the pairing, but only the one the server just disowned: a pairing committed meanwhile stays (identity checks the
 * id and wipes under one lock). Sets wipe_retry when the NVS erase failed; the retry in tick() ends here too. */
static void try_wipe(void)
{
    esp_err_t e = identity_wipe_if(ctx.dev);
    wipe_retry = e != ESP_OK && e != ESP_ERR_INVALID_STATE && e != ESP_ERR_NOT_FOUND;
    if (e == ESP_ERR_NOT_FOUND) ESP_LOGW(TAG, "wipe skipped: the board was paired again meanwhile");
    else if (wipe_retry) ESP_LOGE(TAG, "wiping the pairing failed: %s (retrying)", esp_err_to_name(e));
    else if (!identity_paired()) after_wipe();
}

static void do_wipe(void)
{
    link_ws_close();
    try_wipe();
}

static void on_online(void)
{
    ws_online = true;
    open_ms = last_hb = last_metrics = ms();
    stable_sent = false;
    send_hello();
    flush_acks();
    link_send_wifi_state();
    xSemaphoreTake(act_mu, portMAX_DELAY);
    link_acts_unsend_all(&acts, ms()); /* every open action goes out again with its own id */
    xSemaphoreGive(act_mu);
    send_actions();
}

static void on_offline(void)
{
    ws_online = false;
    xSemaphoreTake(act_mu, portMAX_DELAY);
    link_acts_unsend_all(&acts, ms());
    xSemaphoreGive(act_mu);
}

/* Feeds one event to the FSM and runs the action it returns; an action that finishes at once gives the next event. */
static void dispatch(link_event_t ev, int code)
{
    for (;;) {
        link_state_t before = fsm.st;
        uint32_t wait = 0;
        link_action_t a = link_next(&fsm, ev, code, esp_random(), &wait);
#ifdef CONFIG_AELYS_PERF_PROBE
        atomic_store_explicit(&probe_state, (int)fsm.st, memory_order_relaxed);
#endif
        if (wait) backoff_deadline = ms() + wait;
        if (before != fsm.st) ESP_LOGI(TAG, "state %d -> %d", (int)before, (int)fsm.st);
        if (before == LS_ONLINE && fsm.st != LS_ONLINE) on_offline();
        sync_ui();
        int next = NO_EVENT;
        code = 0;
        switch (a) {
        case LA_LOGIN: next = do_login(); if (next != LE_LOGIN_OK) explicit_bzero(link_mem->token, LINK_TOKEN_MAX); break;
        case LA_CHECK: next = do_check(); break;
        case LA_CLOSE_LOGIN:
            link_ws_close();
            next = do_login();
            if (next != LE_LOGIN_OK) explicit_bzero(link_mem->token, LINK_TOKEN_MAX);
            break;
        case LA_CLOSE: link_ws_close(); break;
        case LA_CONNECT:
            if (!do_connect()) next = LE_WS_CLOSED; /* could not even start: back off */
            break;
        case LA_WIPE_PAIRING: do_wipe(); break;
        default: break;
        }
        if (next == NO_EVENT) return;
        ev = (link_event_t)next;
    }
}

void link_wifi_switched(void)
{
    net_up = false; /* tick() sees the network again (or its return) as an up edge and signs in */
    dispatch(LE_NET_DOWN, 0);
}

void link_unpair(void) { dispatch(LE_UNPAIR, 0); } /* LA_WIPE_PAIRING: do_wipe -> try_wipe -> after_wipe */

/* ------------------------------------------------------------------ frames */

static void handle_frame(int slot, int len)
{
    proto_msg_t *m = &link_mem->msg;
    bool ok = proto_parse(link_mem->rx[slot], (size_t)len, m);
    link_ws_slot_free(slot);
    if (m->type == MSG_COMMAND) { /* a bad-args command still has its id: it gets BAD_ARGS */
        if (fsm.st == LS_ONLINE) link_cmd_handle(m, ok);
        return;
    }
    if (!ok) { ESP_LOGW(TAG, "bad frame ignored"); return; }
    if (m->type == MSG_READY) {
        if (fsm.st != LS_CONNECT) return;
        if (strcmp(m->id, ctx.dev) != 0) { /* a server that thinks we are someone else */
            ESP_LOGW(TAG, "ready for another device id: closing");
            link_ws_close();
            dispatch(LE_WS_CLOSED, 0);
            return;
        }
        dispatch(LE_WS_OPEN, 0);
        if (fsm.st == LS_ONLINE) on_online();
        return;
    }
    if (fsm.st != LS_ONLINE) return;
    switch (m->type) {
    case MSG_SNAPSHOT:
        link_mem->snap = m->u.snap;
        publish_snapshot(&link_mem->snap, true);
        snap_dirty = true;
        break;
    case MSG_ACTION_RESULT: {
        act_kind_t k;
        xSemaphoreTake(act_mu, portMAX_DELAY);
        bool found = link_acts_done(&acts, m->id, &k);
        xSemaphoreGive(act_mu);
        if (found) post_action_result(k, m->u.result.ok, m->u.result.error);
        break;
    }
    case MSG_ERROR: /* against a v1 server, wifi_state draws UNKNOWN_MESSAGE: only the code is logged */
        ESP_LOGW(TAG, "server error %.31s", m->u.error.code);
        break;
    default:
        break;
    }
}

/* ------------------------------------------------------------------- events */

static bool net_ok(void)
{
    esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    esp_netif_ip_info_t ip = {0};
    /* no TLS before SNTP has set the clock: certificate dates cannot be checked against 1970 */
    return sta && esp_netif_is_netif_up(sta) && esp_netif_get_ip_info(sta, &ip) == ESP_OK && ip.ip.addr != 0 &&
           time(NULL) >= CLOCK_SET_MIN;
}

static void handle_paired(void)
{
    if (paired_seq == seen_seq) return;
    seen_seq = paired_seq;
    wipe_retry = false; /* a wipe of the old identity must not eat the new one */
    n_held = 0;
    if (link_deps.reset_revs) link_deps.reset_revs(); /* new account: its revisions start again */
    dispatch(LE_PAIRED, 0);
    if (!net_ok()) dispatch(LE_NET_DOWN, 0); /* paired over USB while offline: the next Wi-Fi up edge signs in */
}

static void handle_q(const lq_t *e)
{
    switch (e->kind) {
    case LQ_PAIRED:
        handle_paired(); /* the event only wakes the task: tick() also notices the counter, so a dropped event is harmless */
        break;
    case LQ_ACTION:
        act_queued = false;
        if (fsm.st == LS_ONLINE) send_actions();
        break;
    case LQ_WS_FRAME:
        if (e->gen == link_ws_gen()) handle_frame(e->a, e->b);
        break;
    case LQ_WS_CLOSED:
        if (e->gen != link_ws_gen()) break;
        link_ws_close();
        dispatch(LE_WS_CLOSED, e->a);
        break;
    }
}

#if CONFIG_AELYS_LINK_CHAOS_S > 0
static bool chaos_due(uint32_t now) { return now - open_ms >= CONFIG_AELYS_LINK_CHAOS_S * 1000u; }
#else
static bool chaos_due(uint32_t now) { (void)now; return false; }
#endif

static void tick(void)
{
    handle_paired();
    bool up = net_ok();
    if (up != net_up) {
        net_up = up;
        if (up && ++net_ups > 1) reconnects++;
        dispatch(up ? LE_NET_UP : LE_NET_DOWN, 0);
    }
    if (fsm.st == LS_BACKOFF && due(backoff_deadline)) dispatch(LE_TIMER, 0);
    if (fsm.st == LS_CONNECT && due(connect_deadline)) {
        ESP_LOGW(TAG, "no ready from the server in time");
        link_ws_close();
        dispatch(LE_WS_CLOSED, 0);
    }
    if ((fsm.st == LS_CONNECT || fsm.st == LS_ONLINE) && link_ws_lost_frame()) {
        ESP_LOGW(TAG, "frame dropped, reconnecting"); /* the hello after the reconnect resends pending commands and brings a fresh snapshot */
        link_ws_close();
        dispatch(LE_WS_CLOSED, 0);
    }
    if (fsm.st == LS_ONLINE) {
        uint32_t now = ms();
        if (!stable_sent && now - open_ms >= LINK_STABLE_MS) {
            stable_sent = true;
            dispatch(LE_WS_STABLE, 0);
        }
        if ((int32_t)(now - link_ws_last_rx_ms()) >= (int32_t)SILENCE_MS) {
            ESP_LOGW(TAG, "socket silent for 75 s: closing");
            link_ws_close();
            dispatch(LE_WS_CLOSED, 0);
        } else if (chaos_due(now)) {
            ESP_LOGW(TAG, "chaos: forced reconnect");
            dispatch(LE_NET_DOWN, 0); /* closes the socket ... */
            dispatch(LE_NET_UP, 0);   /* ... and signs in again at once (dev builds only) */
        } else {
            if (now - last_hb >= HB_MS) {
                last_hb = now;
                link_send_raw(link_mem->tx, proto_heartbeat(link_mem->tx, sizeof link_mem->tx));
            }
            if (now - last_metrics >= METRICS_MS) {
                last_metrics = now;
                send_metrics();
            }
        }
    }
    if (fsm.st == LS_ONLINE && acts.n) send_actions(); /* anything the queue missed */
    if (acts.n) { /* racy read of n is fine: the table is locked below */
        xSemaphoreTake(act_mu, portMAX_DELAY);
        size_t k = link_acts_expire(&acts, ms(), ctx.expired);
        xSemaphoreGive(act_mu);
        for (size_t i = 0; i < k; i++) post_action_result(ctx.expired[i].kind, false, ctx.expired[i].sent ? "TIMEOUT" : "OFFLINE");
    }
    if (link_deps.save_snap &&
        link_snap_save_due(snap_dirty, link_deps.lost_on && link_deps.lost_on(), last_snap_save == 0, (uint32_t)(ms() - last_snap_save))) {
        snap_dirty = false;
        last_snap_save = ms() | 1u; /* 0 means never */
        link_deps.save_snap(&link_mem->snap);
    }
    if (wipe_retry) try_wipe();
    sync_ui();
}

static void link_task(void *arg)
{
    (void)arg;
    seen_seq = paired_seq; /* a pairing before this point is already in identity_paired() */
    bool paired = identity_paired();
    link_fsm_init(&fsm, paired);
#ifdef CONFIG_AELYS_PERF_PROBE
    atomic_store_explicit(&probe_state, (int)fsm.st, memory_order_relaxed);
#endif
    ui_posted = paired ? LINK_UI_OFFLINE : LINK_UI_UNPAIRED; /* what app_main already showed at boot */
    if (link_deps.load_snap && link_deps.load_snap(&link_mem->snap)) publish_snapshot(&link_mem->snap, false);
    ESP_LOGW(TAG, "link started: paired=%d", paired);
    for (;;) {
        lq_t e;
        if (xQueueReceive(q, &e, pdMS_TO_TICKS(100)) == pdTRUE) handle_q(&e);
        tick();
    }
}

void link_notify_paired(void)
{
    paired_seq++;
    link_q_post(LQ_PAIRED, 0, 0, 0);
}

esp_err_t link_start(const link_deps_t *d)
{
    if (!d || link_mem) return ESP_ERR_INVALID_STATE;
    link_deps = *d;
    link_mem = heap_caps_calloc(1, sizeof *link_mem, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    act_mu = xSemaphoreCreateMutex();
    q = xQueueCreate(12, sizeof(lq_t));
    link_acts_init(&acts);
    if (!link_mem || !act_mu || !q ||
        xTaskCreatePinnedToCore(link_task, "link", LINK_STACK, NULL, 5, NULL, 0) != pdPASS) {
        ESP_LOGE(TAG, "start failed (out of memory)");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

#ifdef CONFIG_AELYS_PERF_PROBE
int link_probe_state(void) { return atomic_load_explicit(&probe_state, memory_order_relaxed); }
#endif
