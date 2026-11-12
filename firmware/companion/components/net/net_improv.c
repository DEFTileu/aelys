/* Improv Serial (https://www.improv-wifi.com/serial/) on the USB-Serial/JTAG console, next to the
 * log output. The usb_serial_jtag driver owns RX; logs keep their own polled TX path. Frames are
 * written through the driver so binary bytes are not CRLF-translated. Never logs credentials. */
#include <string.h>
#include "driver/usb_serial_jtag.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "improv.h"
#include "net_priv.h"

#define GAP_US 100000 /* silence inside a frame this long: drop the partial frame */

static const char *TAG = "improv";
static improv_parser_t par;
static int64_t last_rx_us;
static bool ready;

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

static uint8_t current_state(void) { return net_wifi_online() ? IMPROV_ST_PROVISIONED : IMPROV_ST_AUTHORIZED; }

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
        send_byte(IMPROV_TYPE_STATE, IMPROV_ST_PROVISIONING);
        bool ok = net_wifi_provision(ssid, pass);
        explicit_bzero(pass, sizeof pass);
        if (ok) {
            send_byte(IMPROV_TYPE_STATE, IMPROV_ST_PROVISIONED);
            send_result(IMPROV_RPC_WIFI, NULL, 0); /* no device URL */
        } else {
            send_byte(IMPROV_TYPE_ERROR, IMPROV_ERR_CONNECT);
            send_byte(IMPROV_TYPE_STATE, IMPROV_ST_AUTHORIZED);
        }
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
    default:
        send_byte(IMPROV_TYPE_ERROR, IMPROV_ERR_UNKNOWN_RPC);
    }
}

esp_err_t net_improv_init(void)
{
    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    esp_err_t err = usb_serial_jtag_driver_install(&cfg);
    ready = err == ESP_OK;
    return err;
}

void net_improv_poll(void)
{
    if (!ready) { vTaskDelay(pdMS_TO_TICKS(10)); return; }
    uint8_t b[64];
    int n = usb_serial_jtag_read_bytes(b, sizeof b, pdMS_TO_TICKS(10));
    int64_t now = esp_timer_get_time();
    if ((par.st || par.idx) && now - last_rx_us > GAP_US) memset(&par, 0, sizeof par);
    for (int i = 0; i < n; i++) {
        improv_frame_t f;
        int r = improv_feed(&par, b[i], &f);
        if (r == 1) handle(&f);
        else if (r < 0) send_byte(IMPROV_TYPE_ERROR, IMPROV_ERR_INVALID_RPC);
    }
    if (n > 0) last_rx_us = esp_timer_get_time(); /* after handle(): it may have blocked for seconds */
}
