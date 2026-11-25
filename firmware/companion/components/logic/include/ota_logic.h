#pragma once
/* OTA version/metadata decision and post-update confirmation window. Pure C, no IDF. */
#include <stdbool.h>
#include <stdint.h>

/* "MAJOR.MINOR.PATCH", each 0..999 (1-3 digits). 0 ok, -1 bad. */
int semver_parse(const char *s, uint16_t out[3]);
/* <0, 0, >0; unparsable input sorts lowest (two unparsable compare equal). */
int semver_cmp(const char *a, const char *b);

typedef struct {
    char version[12];
    char min_version[12];
    char url[96];
    char sha256[65];
    uint32_t size;
} ota_meta_t;

typedef enum {
    OTA_INSTALL, OTA_UP_TO_DATE, OTA_TOO_OLD, OTA_KNOWN_BAD, OTA_BAD_URL, OTA_BAD_SIZE, OTA_BAD_META
} ota_verdict_t;

/* bad_version: a release that rolled back before; NULL or "" means none. */
ota_verdict_t ota_decide(const char *running, const char *bad_version, const ota_meta_t *m, uint32_t slot_size);

typedef enum { CONFIRM_WAIT, CONFIRM_VALID, CONFIRM_ROLLBACK } confirm_t;
typedef struct { bool pending; bool got_ready, got_snapshot, sent_hello; uint32_t deadline_ms; } ota_confirm_t;

void ota_confirm_start(ota_confirm_t *c, bool pending_verify, uint32_t now_ms, uint32_t window_ms);
enum { OTA_EV_TICK = 0, OTA_EV_READY = 1, OTA_EV_SNAPSHOT = 2, OTA_EV_HELLO_SENT = 3 };
/* channel_event: an OTA_EV_* value. VALID once all three happened before the
 * deadline; at/after it a still-pending release must ROLLBACK, even on success. */
confirm_t ota_confirm_update(ota_confirm_t *c, uint8_t channel_event, uint32_t now_ms);
