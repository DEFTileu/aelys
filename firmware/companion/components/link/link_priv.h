#pragma once
/* Internal to components/link. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "link.h"
#include "link_core.h"

#define LINK_RX_SLOTS 3
#define LINK_FRAME_MAX 4096   /* contract: a server frame is at most 4 KB; bigger is dropped (log: code only) */
#define LINK_HTTP_MAX 2048    /* a sign-in response is well under 1 KB */
#define LINK_TOKEN_MAX 1024

/* Buffers that live in PSRAM (internal RAM stays for Wi-Fi, TLS state and the UI). */
typedef struct {
    char rx[LINK_RX_SLOTS][LINK_FRAME_MAX + 1]; /* websocket frames: the ws task fills a free slot, the link task frees it */
    char tx[1024];                              /* outgoing frames and the Authorization header */
    char http[LINK_HTTP_MAX];                   /* HTTP response body */
    char token[LINK_TOKEN_MAX];                 /* access token: RAM only, zeroed once the socket has it */
    proto_msg_t msg;                            /* the frame being handled */
    snap_t snap;                                /* last snapshot, kept for the flash copy */
} link_mem_t;
extern link_mem_t *link_mem;
extern link_deps_t link_deps;

/* events from other tasks to the link task */
typedef enum { LQ_PAIRED, LQ_ACTION, LQ_WS_FRAME, LQ_WS_CLOSED } lq_kind_t;
bool link_q_post(lq_kind_t k, uint32_t gen, int32_t a, int32_t b); /* LQ_WS_FRAME: a = slot, b = length; LQ_WS_CLOSED: a = close code */
void link_tls_failed(void);                                        /* count one failed TLS handshake */
void link_heap_gate(const char *what);                             /* wait for a 16 KB internal block, log the connect line */

/* link_http.c */
link_http_t link_http_challenge(const char *api_url, const char *device_id, char id[40], char nonce[80]);
link_http_t link_http_login(const char *api_url, const char *challenge_id, const char *sig, char *token, size_t cap);

/* link_ws.c. A generation number tags every socket: events of an older one are dropped by the caller. */
uint32_t link_ws_open(const char *api_url, const char *token);   /* 0 = could not start */
void link_ws_close(void);                                        /* idempotent; invalidates the generation */
bool link_ws_send(const char *json, size_t n);
uint32_t link_ws_gen(void);                                      /* 0 = no socket */
uint32_t link_ws_last_rx_ms(void);                               /* any frame, pings and pongs included */
void link_ws_slot_free(int slot);

/* link_cmd.c: a parsed command frame. args_ok false = the args did not validate (proto_parse returned false). */
void link_cmd_handle(const proto_msg_t *m, bool args_ok);
