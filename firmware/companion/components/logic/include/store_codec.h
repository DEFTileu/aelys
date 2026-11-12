#pragma once
/* Versioned settings blobs for NVS: [version][payload][CRC32 LE]. Pure C, no IDF.
 * Decoders write *out only on success and always NUL-terminate every string field. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "owner.h"

#define WIFI_MAX 5
#define STORE_VERSION 2 /* v2: owner_info_t gained email, ice_rel, show, qr. v1 blobs only held factory data and are dropped. */

typedef struct { char ssid[33]; char pass[65]; } wifi_cred_t;
typedef struct { uint8_t n; wifi_cred_t net[WIFI_MAX]; } wifi_list_t;

/* Blob sizes (version + struct + crc), for sizing NVS buffers. */
#define STORE_OWNER_BLOB (1 + sizeof(owner_info_t) + 4)
#define STORE_WIFI_BLOB  (1 + sizeof(wifi_list_t) + 4)
#define STORE_LOST_BLOB  (1 + sizeof(lost_state_t) + 4)

uint32_t store_crc32(const uint8_t *p, size_t n); /* IEEE 802.3, crc32("123456789") = 0xCBF43926 */

/* encode: returns bytes written, 0 if cap is too small. decode: false on bad version/len/crc. */
size_t store_encode_owner(const owner_info_t *in, uint8_t *buf, size_t cap);
bool   store_decode_owner(const uint8_t *buf, size_t len, owner_info_t *out);
size_t store_encode_wifi(const wifi_list_t *in, uint8_t *buf, size_t cap);
bool   store_decode_wifi(const uint8_t *buf, size_t len, wifi_list_t *out); /* also false if n > WIFI_MAX */
size_t store_encode_lost(const lost_state_t *in, uint8_t *buf, size_t cap);
bool   store_decode_lost(const uint8_t *buf, size_t len, lost_state_t *out);

/* Replaces the password of an existing SSID in place; otherwise appends, dropping the oldest
 * (index 0) when full. Returns false (list unchanged) if ssid is empty or ssid/pass do not fit. */
bool wifi_list_upsert(wifi_list_t *l, const char *ssid, const char *pass);
