/* Improv Serial (https://www.improv-wifi.com/serial/) on the USB-Serial/JTAG console, next to the
 * log output. The usb_serial_jtag driver owns RX and, once installed, the console (stdout) TX too, so
 * logs and frames go through one path. Frames use write_bytes so binary bytes are not CRLF-translated. Never logs credentials. */
#include <string.h>
#include "board.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "identity.h"
#include "improv.h"
#include "net_priv.h"
#include "ui_events.h"

#define GAP_US 100000 /* silence inside a frame this long: drop the partial frame */
#define PAIR_TTL_US 180000000LL /* a begun pairing that is not committed by then is dropped */

static const char *TAG = "improv";
static improv_parser_t par;
static int64_t last_rx_us;
static bool ready;
static bool provisioning;
/* A Wi-Fi RPC that arrives while an attempt is running: parked here, the attempt is aborted and the
 * net task runs it next. Wiped as soon as it is taken. */
static struct { bool set; char ssid[33], pass[65]; } pending;

/* USB pairing, RAM only. The identity API is single-threaded: only this (net) task calls it. */
static struct { bool active, coded; int64_t deadline_us; char secret[129]; } pair; /* secret is "" once the SAS was computed */

static void send(uint8_t type, const uint8_t *data, size_t len)
{
    uint8_t buf[10 + 160];
    size_t n = improv_build(type, data, len, buf, sizeof buf);
    if (n) usb_serial_jtag_write_bytes(buf, n, pdMS_TO_TICKS(100));
}

static void send_byte(uint8_t type, uint8_t v) { send(type, &v, 1); }

/* RPC result: command, length of the rest, then each string as length + bytes. */
static void send_result(uint8_t cmd, const char *const *str, int n)
{
    uint8_t d[150];
    size_t i = 2;
    for (int k = 0; k < n; k++) {
        size_t l = strlen(str[k]);
        if (i + 1 + l > sizeof d) break;
        d[i++] = (uint8_t)l;
        memcpy(d + i, str[k], l);
        i += l;
    }
    d[0] = cmd;
    d[1] = (uint8_t)(i - 2);
    send(IMPROV_TYPE_RESULT, d, i);
}

static uint8_t current_state(void)
{
    if (provisioning) return IMPROV_ST_PROVISIONING;
    return net_wifi_online() ? IMPROV_ST_PROVISIONED : IMPROV_ST_AUTHORIZED;
}

/* Runs the request and answers it; a request that arrived meanwhile is run right after. Wipes the
 * password buffer it is given. */
static void provision_and_reply(char ssid[33], char pass[65])
{
    for (;;) {
        provisioning = true;
        send_byte(IMPROV_TYPE_STATE, IMPROV_ST_PROVISIONING);
        bool ok = net_wifi_provision(ssid, pass);
        provisioning = false;
        explicit_bzero(pass, 65);
        if (ok) {
            send_byte(IMPROV_TYPE_STATE, IMPROV_ST_PROVISIONED);
            send_result(IMPROV_RPC_WIFI, NULL, 0); /* no device URL */
        } else {
            send_byte(IMPROV_TYPE_ERROR, IMPROV_ERR_CONNECT);
            send_byte(IMPROV_TYPE_STATE, IMPROV_ST_AUTHORIZED);
        }
        if (!pending.set) return;
        memcpy(ssid, pending.ssid, 33);
        memcpy(pass, pending.pass, 65);
        explicit_bzero(&pending, sizeof pending);
    }
}

void net_improv_run_pending(void)
{
    if (!pending.set) return;
    char ssid[33], pass[65];
    memcpy(ssid, pending.ssid, 33);
    memcpy(pass, pending.pass, 65);
    explicit_bzero(&pending, sizeof pending);
    provision_and_reply(ssid, pass);
    explicit_bzero(pass, sizeof pass);
}

/* The pair screen is the only place the SAS appears, so a full event queue is retried briefly. */
static void post_pair(uint8_t state, const char *digits)
{
    ui_event_t ev = {.type = UI_EV_PAIR, .len = digits ? 7 : 1, .data = {state}};
    if (digits) memcpy(&ev.data[1], digits, 6);
    for (int i = 0; i < 20 && !lv_port_post(&ev); i++) vTaskDelay(pdMS_TO_TICKS(10));
    explicit_bzero(&ev, sizeof ev);
}

static void pair_drop(void)
{
    explicit_bzero(pair.secret, sizeof pair.secret);
    pair.active = pair.coded = false;
    identity_pair_cancel();
}

static void handle_pair(const improv_frame_t *f)
{
    char s[2][129];
    int n = improv_rpc_strings(f, s, 2);
    uint8_t cmd = f->data[0];
    uint8_t err = IMPROV_ERR_NONE;
    switch (cmd) {
    case IMPROV_RPC_PAIR_BEGIN: {
        size_t sl = n == 2 ? strlen(s[0]) : 0;
        if (net_lost_on()) { err = IMPROV_ERR_LOST_MODE; break; }
        if (n != 2 || sl < 32 || sl > 128) { err = IMPROV_ERR_INVALID_RPC; break; }
        pair_drop(); /* a second or failing begin leaves no old key, secret or digits behind */
        post_pair(PAIR_UI_HIDE, NULL);
        if (identity_pair_begin(s[1]) != ESP_OK) { err = IMPROV_ERR_INVALID_RPC; break; }
        char pub[88];
        if (identity_pub_b64(pub) != ESP_OK) { identity_pair_cancel(); err = IMPROV_ERR_UNKNOWN; break; }
        memcpy(pair.secret, s[0], sl + 1);
        pair.deadline_us = esp_timer_get_time() + PAIR_TTL_US;
        pair.active = true;
        const char *res[] = { pub };
        send_result(cmd, res, 1);
        ESP_LOGI(TAG, "pairing begun");
        break;
    }
    case IMPROV_RPC_PAIR_CODE: {
        if (net_lost_on()) { pair_drop(); err = IMPROV_ERR_LOST_MODE; break; }
        if (n != 1 || !s[0][0] || strlen(s[0]) > 39) { err = IMPROV_ERR_INVALID_RPC; break; }
        if (!pair.active || !pair.secret[0]) { err = IMPROV_ERR_NOT_PENDING; break; }
        char sas[7];
        esp_err_t e = identity_pair_code(pair.secret, s[0], sas);
        explicit_bzero(pair.secret, sizeof pair.secret); /* the secret is needed once */
        if (e != ESP_OK) { err = IMPROV_ERR_UNKNOWN; break; }
        pair.coded = true;
        post_pair(PAIR_UI_CODE, sas);
        explicit_bzero(sas, sizeof sas);
        send_result(cmd, NULL, 0);
        break;
    }
    case IMPROV_RPC_PAIR_COMMIT: {
        if (net_lost_on()) { pair_drop(); err = IMPROV_ERR_LOST_MODE; break; }
        if (n != 1 || !improv_is_uuid(s[0])) { err = IMPROV_ERR_INVALID_RPC; break; }
        if (!pair.active || !pair.coded) { err = IMPROV_ERR_NOT_PENDING; break; }
        if (identity_pair_commit(s[0]) != ESP_OK) { err = IMPROV_ERR_UNKNOWN; break; } /* pending stays: retry */
        explicit_bzero(pair.secret, sizeof pair.secret);
        pair.active = pair.coded = false;
        post_pair(PAIR_UI_DONE, NULL);
        send_result(cmd, NULL, 0);
        ESP_LOGW(TAG, "paired");
        break;
    }
    default: { /* IMPROV_RPC_PAIR_STATUS */
        const char *res[] = { identity_paired() ? "paired" : "unpaired", identity_device_id() };
        send_result(cmd, res, identity_paired() ? 2 : 1);
    }
    }
    if (err) send_byte(IMPROV_TYPE_ERROR, err);
    explicit_bzero(s, sizeof s);
}

static void handle(const improv_frame_t *f)
{
    if (f->type != IMPROV_TYPE_RPC || f->len < 2 || f->data[1] != f->len - 2) {
        send_byte(IMPROV_TYPE_ERROR, IMPROV_ERR_INVALID_RPC);
        return;
    }
    send_byte(IMPROV_TYPE_ERROR, IMPROV_ERR_NONE); /* spec: clear the error, then answer */
    switch (f->data[0]) {
    case IMPROV_RPC_WIFI: {
        char ssid[33], pass[65];
        if (!improv_parse_wifi(f, ssid, pass)) {
            send_byte(IMPROV_TYPE_ERROR, IMPROV_ERR_INVALID_RPC);
            return;
        }
        ESP_LOGI(TAG, "wifi settings received");
        if (net_wifi_busy()) { /* called from inside an attempt: replace it, run after it returns */
            memcpy(pending.ssid, ssid, sizeof ssid);
            memcpy(pending.pass, pass, sizeof pass);
            pending.set = true;
            net_wifi_abort();
        } else {
            provision_and_reply(ssid, pass);
        }
        explicit_bzero(pass, sizeof pass);
        return;
    }
    case IMPROV_RPC_STATE:
        send_byte(IMPROV_TYPE_STATE, current_state());
        if (net_wifi_online()) send_result(IMPROV_RPC_WIFI, NULL, 0);
        return;
    case IMPROV_RPC_INFO: {
        const char *info[] = { "aelys-companion", esp_app_get_description()->version, "ESP32-S3", "Aelys" };
        send_result(IMPROV_RPC_INFO, info, 4);
        return;
    }
    case IMPROV_RPC_PAIR_BEGIN:
    case IMPROV_RPC_PAIR_CODE:
    case IMPROV_RPC_PAIR_COMMIT:
    case IMPROV_RPC_PAIR_STATUS:
        handle_pair(f);
        return;
    default:
        send_byte(IMPROV_TYPE_ERROR, IMPROV_ERR_UNKNOWN_RPC);
    }
}

esp_err_t net_improv_init(void)
{
    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    esp_err_t err = usb_serial_jtag_driver_install(&cfg);
    ready = err == ESP_OK;
    if (ready) usb_serial_jtag_vfs_use_driver(); /* logs and frames share the driver's TX path: frames stay whole */
    return err;
}

void net_improv_poll(void)
{
    if (!ready) { vTaskDelay(pdMS_TO_TICKS(10)); return; }
    uint8_t b[64];
    int n = usb_serial_jtag_read_bytes(b, sizeof b, pdMS_TO_TICKS(10));
    int64_t now = esp_timer_get_time();
    if (pair.active && now > pair.deadline_us) { /* expired: wipe it and take the code off the screen */
        pair_drop();
        post_pair(PAIR_UI_HIDE, NULL);
        ESP_LOGW(TAG, "pairing expired");
    }
    if ((par.st || par.idx) && now - last_rx_us > GAP_US) memset(&par, 0, sizeof par);
    for (int i = 0; i < n; i++) {
        improv_frame_t f;
        int r = improv_feed(&par, b[i], &f);
        explicit_bzero(b, i + 1); /* consumed bytes may be the password: gone before handle() blocks */
        if (r == 1) handle(&f);
        else if (r < 0) send_byte(IMPROV_TYPE_ERROR, IMPROV_ERR_INVALID_RPC);
        explicit_bzero(&f, sizeof f); /* a coredump of this stack must not hold a Wi-Fi password */
    }
    explicit_bzero(b, sizeof b);
    if (n > 0) last_rx_us = esp_timer_get_time(); /* after handle(): it may have blocked for seconds */
}
