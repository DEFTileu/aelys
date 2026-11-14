#pragma once
/* Companion channel codec: parses server->board JSON, builds board->server JSON. Pure C, no allocation.
 * Contract: docs/companion-protocol.md (v1.1). Builders return the bytes written (NUL-terminated),
 * or 0 when the message does not fit in cap. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "owner.h"
#include "snap.h"
#include "store_codec.h"

typedef enum { ACT_NOTIFICATION_READ, ACT_FOCUS_START, ACT_FOCUS_PAUSE, ACT_FOCUS_RESUME, ACT_FOCUS_STOP, ACT_TASK_COMPLETE } act_kind_t;
typedef enum { CMD_LOST_MODE, CMD_PLAY_SOUND, CMD_ICE_UPDATE, CMD_WIFI_ADD, CMD_WIFI_SCAN, CMD_SETTINGS, CMD_WIFI_REMOVE,
               CMD_WIFI_ORDER, CMD_RESTART, CMD_UNPAIR, CMD_UNKNOWN } cmd_name_t;
typedef enum { MSG_READY, MSG_HB_ACK, MSG_SNAPSHOT, MSG_ACTION_RESULT, MSG_COMMAND, MSG_ERROR, MSG_UNKNOWN } msg_type_t;

typedef struct {
    msg_type_t type;
    char id[40]; /* action/command id; ready: device_id */
    union {
        snap_t snap;
        struct { bool ok; char error[24]; } result;
        struct { char code[32]; } error;
        struct {
            cmd_name_t name;
            char raw_name[16]; /* the name as sent, cut; meaningful for CMD_UNKNOWN */
            union {
                lost_cmd_t lost;
                ice_cmd_t ice;
                char blob[704]; /* wifi_add: the base64url string, NUL-terminated */
                struct { uint8_t brightness; uint32_t rev; } settings; /* rev 0 = missing */
                char ssid[33];  /* wifi_remove */
                struct { uint8_t n; char ssid[5][33]; } order;
            } a;
        } cmd;
    } u;
} proto_msg_t; /* ~2.3 KB (it holds a snap_t): callers keep it static, never on a task stack */

typedef struct { char ssid[33]; int8_t rssi; bool secure; } wifi_seen_t;
/* In place: one entry per SSID (the strongest), sorted by RSSI descending (equal: first seen first), cut at max. Hidden (empty) and
 * non-UTF-8 SSIDs are dropped (the server would reject the frame). Returns the new count; v holds at least n entries. */
int wifi_seen_merge(wifi_seen_t *v, int n, int max);
typedef struct {
    uint32_t heap_min_internal, largest_block, psram_free, wifi_reconnects, uptime_s;
    int8_t battery_pct; /* 0..100, -1 = omit battery_pct and charging */
    bool charging;
    uint32_t heap_at_connect_min;
} proto_metrics_t;

/* false: not JSON, no "type", len > 4096, or a known type with missing/invalid required fields.
 * An unknown "type" gives MSG_UNKNOWN; a command with an unknown "name" gives CMD_UNKNOWN (ack UNSUPPORTED).
 * When a command has a valid id and known name but bad args, returns false with out->type == MSG_COMMAND,
 * out->id and out->u.cmd.name set, so the caller can ack BAD_ARGS. In every other false case out->type == MSG_UNKNOWN. */
bool proto_parse(const char *json, size_t len, proto_msg_t *out);

/* phone/telegram NULL or empty = omit that part; both omitted = no `contacts` key (the server keeps what it stored) */
size_t proto_hello(char *buf, size_t cap, const char *fw, const char *board, const char *phone, const char *telegram);
/* HTTP sign-in bodies (device auth). Output is written only on success; a value that does not fit is a failure. */
bool proto_parse_challenge(const char *json, size_t len, char id[40], char nonce[80]);
bool proto_parse_login(const char *json, size_t len, char *token, size_t cap); /* reads access_token only: a refresh token is never copied */
bool proto_error_code(const char *json, size_t len, char code[32]);           /* FastAPI {"detail":{"code":...}}; false when there is none */

size_t proto_heartbeat(char *buf, size_t cap);
size_t proto_metrics(char *buf, size_t cap, const proto_metrics_t *m);
size_t proto_action(char *buf, size_t cap, const char id[37], act_kind_t k, const char *target_id /* NULL for focus.* */, const char *focus_mode /* NULL = omit */);
size_t proto_command_ack(char *buf, size_t cap, const char *id, bool ok, const char *error_code /* NULL when ok */);
/* Drops hidden (empty) SSIDs; networks that do not fit are left out (the message stays valid JSON). */
size_t proto_wifi_scan_result(char *buf, size_t cap, const char *id, const wifi_seen_t *nets, int n);
size_t proto_wifi_state(char *buf, size_t cap, const wifi_list_t *saved, const char *current /* NULL -> null */);
const char *act_kind_str(act_kind_t k); /* "notification.read", "focus.start", ... as in the contract */
