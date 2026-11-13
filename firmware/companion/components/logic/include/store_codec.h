#pragma once
/* Versioned settings blobs for NVS: [version][payload][CRC32 LE]. Pure C, no IDF.
 * Decoders write *out only on success and always NUL-terminate every string field. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "owner.h"
#include "snap.h"

#define WIFI_MAX 5
/* Each blob type has its own version byte, so changing one layout never invalidates another.
 * Wi-Fi stays at 1 exactly as plan 1 wrote it (a board must never forget its networks). Owner and lost
 * are 2: owner_info_t gained email, ice_rel, show, qr, ice_rev and lost_state_t gained rev (no v2 blob had been
 * written with app data yet, so the v2 layout was extended in place); their v1 blobs only held factory data and are dropped. */
#define STORE_WIFI_VERSION  1
#define STORE_OWNER_VERSION 2
#define STORE_LOST_VERSION  2
#define STORE_PAIR_VERSION  1
#define STORE_SETTINGS_VERSION 1
#define STORE_SNAP_VERSION  1 /* bump with any change to snap_t: a raw struct dump, so the layout is the format */

typedef struct { char ssid[33]; char pass[65]; } wifi_cred_t;
typedef struct { uint8_t n; wifi_cred_t net[WIFI_MAX]; } wifi_list_t;

/* The companion pairing: who this board is to the backend, and its P-256 private scalar. */
typedef struct { char device_id[40]; char api_url[129]; uint8_t priv[32]; } pair_rec_t;

/* Blob sizes (version + struct + crc), for sizing NVS buffers. */
#define STORE_OWNER_BLOB (1 + sizeof(owner_info_t) + 4)
#define STORE_WIFI_BLOB  (1 + sizeof(wifi_list_t) + 4)
#define STORE_LOST_PAYLOAD (1 + sizeof(uint32_t) + sizeof(owner_info_t)) /* on, rev, shown */
#define STORE_LOST_BLOB  (1 + STORE_LOST_PAYLOAD + 4)
#define STORE_SETTINGS_PAYLOAD (1 + sizeof(uint32_t)) /* brightness, rev */
#define STORE_SETTINGS_BLOB (1 + STORE_SETTINGS_PAYLOAD + 4)
#define STORE_PAIR_BLOB  (1 + sizeof(pair_rec_t) + 4)
#define STORE_SNAP_BLOB  (1 + sizeof(snap_t) + 4)

uint32_t store_crc32(const uint8_t *p, size_t n); /* IEEE 802.3, crc32("123456789") = 0xCBF43926 */

/* encode: returns bytes written, 0 if cap is too small. decode: false on bad version/len/crc. */
size_t store_encode_owner(const owner_info_t *in, uint8_t *buf, size_t cap);
bool   store_decode_owner(const uint8_t *buf, size_t len, owner_info_t *out);
size_t store_encode_wifi(const wifi_list_t *in, uint8_t *buf, size_t cap);
bool   store_decode_wifi(const uint8_t *buf, size_t len, wifi_list_t *out); /* also false if n > WIFI_MAX */
size_t store_encode_lost(const lost_state_t *in, uint8_t *buf, size_t cap);
bool   store_decode_lost(const uint8_t *buf, size_t len, lost_state_t *out);
size_t store_encode_settings(const settings_t *in, uint8_t *buf, size_t cap);
bool   store_decode_settings(const uint8_t *buf, size_t len, settings_t *out); /* also false if brightness is outside 5..100 */
size_t store_encode_pair(const pair_rec_t *in, uint8_t *buf, size_t cap);
bool   store_decode_pair(const uint8_t *buf, size_t len, pair_rec_t *out);
size_t store_encode_snap(const snap_t *in, uint8_t *buf, size_t cap);
bool   store_decode_snap(const uint8_t *buf, size_t len, snap_t *out); /* also false if a count or status is out of range */

/* Replaces the password of an existing SSID in place; otherwise appends, dropping the oldest
 * (index 0) when full. Returns false (list unchanged) if ssid is empty or ssid/pass do not fit. */
bool wifi_list_upsert(wifi_list_t *l, const char *ssid, const char *pass);

/* Removes the network named ssid (exact match), later ones move up and the vacated slot is wiped. True when something was removed. */
bool wifi_list_remove(wifi_list_t *l, const char *ssid);
/* False when removing ssid would strand the board: it is the network in use (in_use, NULL or "" when offline) or the last saved one.
 * A name that is not saved is always fine (the remove changes nothing). Never edits the list. */
bool wifi_list_can_remove(const wifi_list_t *l, const char *ssid, const char *in_use);
/* Listed SSIDs first, in that order (each once); names that are not saved are ignored; the rest keep their order after them.
 * True when the order changed (the list is untouched otherwise). */
bool wifi_list_reorder(wifi_list_t *l, const char ssids[][33], int n);
