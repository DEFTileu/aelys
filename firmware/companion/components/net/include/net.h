#pragma once
/* Wi-Fi station, SNTP and Improv Serial provisioning. Runs in one `net` task on core 0. */
#include <stdbool.h>
#include "esp_err.h"
#include "proto.h"
#include "store_codec.h"

/* Persistence is injected so this component does not depend on main (where the NVS adapter lives). */
typedef struct {
    void (*load)(wifi_list_t *l);
    esp_err_t (*save)(const wifi_list_t *l);
    bool (*lost_on)(void); /* lost mode is on: USB pairing is refused (a missing callback counts as on) */
} net_store_t;

/* Brings Wi-Fi up (STA, modem power save) and starts the net task: tries the saved networks in
 * order, backs off 1 s -> 60 s with jitter, never reboots on failure. Posts UI_EV_WIFI and, once
 * SNTP has set the clock, UI_EV_TIME at every minute change. Reads Improv Serial frames from the
 * USB-Serial/JTAG console; credentials are saved only after a successful connection. */
esp_err_t net_start(const net_store_t *store);

/* Wi-Fi requests from other tasks (the link task). The net task owns Wi-Fi: each call is handed to it, run in its loop (a running
 * reconnect attempt is ended for it) and answered here, one at a time. They block, so never call them from the ui or net task. */

/* Active scan, blocking at most 4 s (plus the hand-over); the connection stays up. Fills out with up to max networks (one per SSID,
 * the strongest, sorted by RSSI, hidden and non-UTF-8 names dropped; max <= 10 for the channel). Returns the count, -1 on failure. */
int net_wifi_scan(wifi_seen_t *out, int max);
/* The network in use, "" when offline. Written by the net task: copy it right away, from a task that is not racing a Wi-Fi change
 * (the command handler, before it calls net_wifi_try). */
const char *net_wifi_current_ssid(void);
typedef enum { NET_TRY_OK, NET_TRY_FAILED, NET_TRY_NOT_RUN } net_try_t;
/* Tries the network now (the provisioning path Improv uses): blocks up to ~18 s. The old link is dropped. NET_TRY_OK: connected and saved. NET_TRY_FAILED: the
 * attempt failed (wrong password, not found, timed out); nothing was saved and the saved networks reconnect at once. NET_TRY_NOT_RUN: it
 * never ran or was replaced by an Improv request (bad arguments, the hand-over slot busy or not picked up, aborted): the network was not
 * judged and the old link was not necessarily touched. Zero the password after the call. */
net_try_t net_wifi_try(const char *ssid, const char *pass);
/* Edits of the saved list (persisted, then adopted; the current connection is left alone). True: the list now is what was asked for
 * (also when there was nothing to change); false: the edit could not be saved or run. */
bool net_wifi_remove(const char *ssid);
bool net_wifi_reorder(const char ssids[][33], int n);
