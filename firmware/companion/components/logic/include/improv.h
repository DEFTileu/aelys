#pragma once
/* Improv Serial v1 framing: "IMPROV", version 1, type, length, data, checksum (byte sum of all
 * preceding bytes, mod 256). Pure C, no IDF. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define IMPROV_VERSION 1
#define IMPROV_TYPE_STATE  0x01
#define IMPROV_TYPE_ERROR  0x02
#define IMPROV_TYPE_RPC    0x03
#define IMPROV_TYPE_RESULT 0x04
#define IMPROV_RPC_WIFI    0x01 /* RPC data: cmd, len, ssid_len, ssid, pass_len, pass */
#define IMPROV_RPC_STATE   0x02 /* request current state */
#define IMPROV_RPC_INFO    0x03 /* request device information */

/* STATE packet payload */
#define IMPROV_ST_AUTHORIZED   0x02
#define IMPROV_ST_PROVISIONING 0x03
#define IMPROV_ST_PROVISIONED  0x04
/* ERROR packet payload */
#define IMPROV_ERR_NONE       0x00
#define IMPROV_ERR_INVALID_RPC 0x01
#define IMPROV_ERR_UNKNOWN_RPC 0x02
#define IMPROV_ERR_CONNECT     0x03
#define IMPROV_ERR_UNKNOWN     0xFF

typedef struct { uint8_t type; uint8_t len; uint8_t data[255]; } improv_frame_t;
typedef struct { uint8_t st, idx, sum; improv_frame_t f; } improv_parser_t; /* zero-initialise */

/* returns 1 when a full valid frame is in *out, 0 need more, -1 bad checksum (parser resets).
 * Bytes before a header, and frames with another version, are skipped silently. */
int improv_feed(improv_parser_t *p, uint8_t byte, improv_frame_t *out);

/* returns bytes written, 0 if cap is too small */
size_t improv_build(uint8_t type, const uint8_t *data, size_t len, uint8_t *buf, size_t cap);

/* Extracts SSID/password from a "send Wi-Fi settings" RPC. False (outputs untouched) on wrong
 * type/command, inconsistent lengths, empty SSID, SSID > 32 or password > 64 bytes. */
bool improv_parse_wifi(const improv_frame_t *f, char ssid[33], char pass[65]);
