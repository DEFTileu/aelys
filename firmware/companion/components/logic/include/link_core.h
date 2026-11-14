#pragma once
/* In-flight board actions for the companion link. Pure C, no IDF. At most LINK_ACT_MAX actions wait for their
 * `action_result`; each is failed when none arrives within LINK_ACT_TIMEOUT_MS of its last (re)send. A reconnect
 * sends every open action again with the SAME id (the server answers a repeated id with the stored result, so the
 * effect happens once). Times are caller milliseconds (wrap-safe: only differences are used). */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "proto.h"

#define LINK_ACT_MAX 4
#define LINK_ACT_TIMEOUT_MS 10000u

typedef struct {
    bool sent;        /* on the wire since the last (re)connect */
    char id[37];      /* UUID v4 chosen by the board */
    act_kind_t kind;
    char target[40];  /* notification or task id, "" for focus.* */
    uint32_t t_ms;    /* when it was added, last sent or last un-sent */
} link_act_t;

typedef struct { link_act_t a[LINK_ACT_MAX]; size_t n; } link_acts_t; /* oldest first */

void link_acts_init(link_acts_t *t);
/* Caller must close admission and serialize this with all table access. */
void link_acts_discard_all(link_acts_t *t);
/* false when LINK_ACT_MAX actions are already in flight, or id/target do not fit. Starts un-sent. */
bool link_acts_add(link_acts_t *t, const char id[37], act_kind_t k, const char *target, uint32_t now_ms);
/* The oldest action not yet on the wire, or NULL. */
const link_act_t *link_acts_next_unsent(const link_acts_t *t);
void link_acts_sent(link_acts_t *t, const char *id, uint32_t now_ms);
/* The socket is gone: every open action becomes un-sent and its timeout restarts at now_ms. */
void link_acts_unsend_all(link_acts_t *t, uint32_t now_ms);
/* An `action_result` arrived: removes the action and gives its kind. False for an id that is not in flight (late or foreign). */
bool link_acts_done(link_acts_t *t, const char *id, act_kind_t *kind);
/* Removes every action older than LINK_ACT_TIMEOUT_MS and copies them (oldest first) to out; returns how many. */
size_t link_acts_expire(link_acts_t *t, uint32_t now_ms, link_act_t out[LINK_ACT_MAX]);

/* Result of one sign-in HTTP call (/auth/device/challenge or /login). */
typedef enum {
    LH_OK,
    LH_UNAUTHORIZED, /* 401 with detail.code == "UNAUTHORIZED": the server does not know this device / signature */
    LH_DENIED,       /* any other 401, or 403 */
    LH_FAIL          /* network, TLS, 5xx, 429, a body we cannot read */
} link_http_t;
/* Status plus body of a reply that was fully read. 200 gives LH_OK (the caller parses the body). Only a 401 whose body
 * names UNAUTHORIZED is LH_UNAUTHORIZED: a missing or unreadable body is LH_DENIED, so it can never wipe a pairing. */
link_http_t link_http_verdict(int status, const char *body, size_t len);

#define LINK_SNAP_SAVE_MS 300000u
/* Flash write of the cached snapshot: at most every LINK_SNAP_SAVE_MS, except at once the first time and whenever lost
 * mode is on (the flash must not keep the data from before it). */
bool link_snap_save_due(bool dirty, bool lost_on, bool never_saved, uint32_t since_last_ms);
