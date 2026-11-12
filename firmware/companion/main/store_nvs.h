#pragma once
/* NVS adapter for the settings blobs (namespace "aelys", keys "owner", "wifi", "lost"). The blob
 * format and its CRC live in components/logic/store_codec. Load never fails: empty or corrupt
 * NVS yields the factory defaults. */
#include "esp_err.h"
#include "store_codec.h"

/* nvs_flash_init(); erases only the nvs partition if it is full or from a newer IDF. */
esp_err_t store_init(void);

void store_load_owner(owner_info_t *o);          /* else owner_defaults() */
esp_err_t store_save_owner(const owner_info_t *o);
void store_load_wifi(wifi_list_t *l);            /* else an empty list */
esp_err_t store_save_wifi(const wifi_list_t *l);
void store_load_lost(lost_state_t *s);           /* else off, empty owner info */
esp_err_t store_save_lost(const lost_state_t *s);
