#pragma once
/* The board's link to the Aelys backend: HTTPS sign-in by device signature, then the wss:// channel
 * (docs/companion-protocol.md). One `link` task owns the decision table (link_fsm) and every socket; other tasks only
 * post events to it. Never logs a token, key, secret or contact. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "proto.h"
#include "snap.h"
#include "store_codec.h"

typedef struct {
    /* Runs in the link task. m is valid only during the call. Must answer with link_send_ack (wifi_scan with a
     * wifi_scan_result built by proto_wifi_scan_result and link_send_raw). BAD_ARGS acks and acks of unknown names are
     * sent by the link itself and never reach this hook. */
    void (*on_command)(const proto_msg_t *m);
    void (*save_snap)(const snap_t *s);   /* flash, at most every 300 s (at once in lost mode) */
    bool (*load_snap)(snap_t *s);         /* false: none saved (or lost mode is on: nothing may show) */
    void (*erase_snap)(void);             /* a wipe: the next owner must not see this one's cached data */
    bool (*lost_on)(void);                /* a snapshot that arrives in lost mode is saved at once, not throttled */
    const char *(*contact_phone)(void);   /* may return NULL or "": left out of `hello` */
    const char *(*contact_telegram)(void);
    const char *(*current_ssid)(void);    /* the network in use, "" offline: for `wifi_state` (the net task is the only one that calls esp_wifi) */
    void (*load_wifi)(wifi_list_t *l);    /* saved networks, for `wifi_state` (only the SSIDs leave the board) */
    void (*reset_revs)(void);             /* lost.rev and owner.ice_rev back to 0, persisted: a re-paired board must not drop
                                           * the new account's lost_mode / ice_update as stale */
} link_deps_t;

/* Creates the `link` task (core 0, prio 5, 8 KB internal stack; buffers in PSRAM). Call once, after net_start and
 * after the ui task ran ui_setup (the snapshot buffer must exist). deps must stay valid (copied). */
esp_err_t link_start(const link_deps_t *d);

/* A pairing was just committed (net task): the link resets the stored command revisions and signs in with the new
 * identity. Safe before link_start (ignored). */
void link_notify_paired(void);

/* ui task: queue an action for the server. False when the board is not online (the UI shows "No connection") or four
 * actions are already waiting. The answer arrives as UI_EV_ACTION. target_id: notification or task id, NULL for focus.* */
bool link_post_action(act_kind_t k, const char *target_id);

/* Unpair command, link task only (an on_command handler), after the ack went out: closes the socket, wipes the pairing
 * unconditionally and runs the same clean-up as a server-side wipe (reset_revs, erase_snap, empty snapshot on screen), then
 * the state machine waits unpaired. Other stored data is the caller's to erase. */
void link_unpair(void);

/* Link task only (an on_command handler): the Wi-Fi network was switched, so the socket is dead or about to be. Closes it and signs in
 * again at once, as soon as the network is up. */
void link_wifi_switched(void);

/* Link task only: an ack that must wait for the channel to come back (wifi_add: switching networks drops it). Held in RAM, at most
 * four (the oldest goes first), sent after the next hello and before wifi_state; forgotten on a wipe or a new pairing. */
void link_queue_ack(const char *cmd_id, bool ok, const char *error_code);

/* Link task only: sends a fresh `wifi_state` (saved SSIDs and the current one). */
void link_send_wifi_state(void);

/* From the link task (command handlers) or any task: false when the socket is not open or the send failed. */
bool link_send_ack(const char *cmd_id, bool ok, const char *error_code);
bool link_send_raw(const char *json, size_t n);

/* Figures for the metrics line. */
uint32_t link_heap_at_connect_min(void);  /* min free internal heap seen right before a TLS connect, 0 = none yet */
uint32_t link_tls_failures(void);         /* TLS handshakes that failed (mbedTLS error or out of memory) */
uint32_t link_ws_stack_free_min(void);    /* smallest free stack the websocket task ever showed, 0 = unknown */

#ifdef CONFIG_AELYS_PERF_PROBE
int link_probe_state(void); /* link_state_t, or -1 before initialization; bench probe only */
#endif
