#pragma once
/* Companion link decision table: sign in, reconnect, and when (only then) to forget the pairing.
 * Pure C, no IDF: the caller runs the returned action and feeds the result back as an event. */
#include <stdbool.h>
#include <stdint.h>

typedef enum { LS_UNPAIRED, LS_WAIT_NET, LS_LOGIN, LS_CONNECT, LS_ONLINE, LS_BACKOFF, LS_CHECK, LS_REPLACED } link_state_t;

typedef enum {
    LE_PAIRED,             /* pairing just succeeded over the live network */
    LE_NET_UP, LE_NET_DOWN,
    LE_LOGIN_OK,
    LE_LOGIN_REJECTED,     /* 401/403 */
    LE_LOGIN_FAIL,         /* net, TLS, 5xx, 429 */
    LE_WS_OPEN,            /* the server's `ready` frame for our device_id arrived, NOT the HTTP upgrade:
                            * Starlette can only send 4401/4403 after accept, so the upgrade alone would loop without backoff */
    LE_WS_CLOSED,          /* + close code, 0 = no code */
    LE_CHALLENGE_UNKNOWN,  /* challenge -> 401 UNAUTHORIZED: the server forgot this device */
    LE_CHALLENGE_OK,
    LE_CHALLENGE_FAIL,     /* anything else */
    LE_TIMER,              /* backoff elapsed */
    LE_UNPAIR              /* owner removed the pairing on the board */
} link_event_t;

typedef enum { LA_NONE, LA_LOGIN, LA_CONNECT, LA_CHECK, LA_WIPE_PAIRING, LA_CLOSE,
                   LA_CLOSE_LOGIN /* close the open socket, then log in (new identity) */ } link_action_t;

typedef struct {
    link_state_t st;
    uint32_t backoff_ms;    /* current un-jittered backoff step, 0 = none yet */
    uint8_t login_rejects;  /* consecutive rejected logins / early 4401-4403 closes, cleared on LE_WS_OPEN and on entering LS_BACKOFF */
} link_fsm_t;

#define LINK_BACKOFF_MIN_MS 1000u
#define LINK_BACKOFF_MAX_MS 60000u

void link_fsm_init(link_fsm_t *f, bool paired);

/* Returns the action to run; *wait_ms > 0 means arm LE_TIMER after that delay (state is LS_BACKOFF).
 * rnd = esp_random() for jitter. Events that make no sense in the current state are ignored (LA_NONE).
 * Caller contract: drop events from stale socket/request generations (tag every attempt with an id);
 * own the request timeouts and emit LE_LOGIN_FAIL / LE_CHALLENGE_FAIL / LE_WS_CLOSED(0) on a hang;
 * LE_PAIRED works from every state: the new identity replaces the old one, so a live socket is closed and the board
 * logs in again (LA_CLOSE_LOGIN when LS_CONNECT/LS_ONLINE, else LA_LOGIN); backoff and reject counters restart.
 * LA_WIPE_PAIRING is returned ONLY for LE_UNPAIR, or LE_CHALLENGE_UNKNOWN while in LS_CHECK. */
link_action_t link_next(link_fsm_t *f, link_event_t ev, int close_code, uint32_t rnd, uint32_t *wait_ms);
