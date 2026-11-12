#pragma once
/* Wi-Fi station, SNTP and Improv Serial provisioning. Runs in one `net` task on core 0. */
#include "esp_err.h"
#include "store_codec.h"

/* Persistence is injected so this component does not depend on main (where the NVS adapter lives). */
typedef struct {
    void (*load)(wifi_list_t *l);
    esp_err_t (*save)(const wifi_list_t *l);
} net_store_t;

/* Brings Wi-Fi up (STA, modem power save) and starts the net task: tries the saved networks in
 * order, backs off 1 s -> 60 s with jitter, never reboots on failure. Posts UI_EV_WIFI and, once
 * SNTP has set the clock, UI_EV_TIME at every minute change. Reads Improv Serial frames from the
 * USB-Serial/JTAG console; credentials are saved only after a successful connection. */
esp_err_t net_start(const net_store_t *store);
