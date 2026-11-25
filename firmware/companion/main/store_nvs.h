#pragma once
/* NVS adapter for the settings blobs (namespace "aelys", keys "owner", "wifi", "lost", "pair", "settings", "ui", "games", "snap"). The blob
 * format and its CRC live in components/logic/store_codec. Load never fails: empty or corrupt
 * NVS yields the factory defaults. */
#include <stdbool.h>
#include "esp_err.h"
#include "snap.h"
#include "store_codec.h"

/* Initialize NVS without erasing; return the original error if initialization fails. */
esp_err_t store_init(void);

void store_load_owner(owner_info_t *o);          /* else owner_defaults() */
esp_err_t store_save_owner(const owner_info_t *o);
void store_load_wifi(wifi_list_t *l);            /* else an empty list */
esp_err_t store_save_wifi(const wifi_list_t *l);
void store_load_lost(lost_state_t *s);           /* else off, empty owner info */
esp_err_t store_save_lost(const lost_state_t *s);
void store_load_settings(settings_t *s);         /* else settings_defaults() */
esp_err_t store_save_settings(const settings_t *s);
void store_load_ui(ui_prefs_t *p);                 /* else everything off */
esp_err_t store_save_ui(const ui_prefs_t *p);
void store_load_games(game_rec_t *g);            /* else nothing played: level 1 open, no best times */
esp_err_t store_save_games(const game_rec_t *g);
bool store_load_pair(pair_rec_t *p);             /* false if absent or corrupt; *p untouched */
esp_err_t store_save_pair(const pair_rec_t *p);
esp_err_t store_erase_pair(void);                /* ESP_OK also when there was no pairing */

/* The last companion snapshot, shown until the server sends a fresh one. A raw struct dump (store_codec): [version][snap_t][CRC32]; a
 * blob from a different snap_t layout (size or version) is ignored, never half-read. */
bool store_load_snap(snap_t *s, const uint8_t owner[STORE_SNAP_OWNER_LEN]);                 /* false if absent, corrupt or from another layout; *s untouched */
esp_err_t store_save_snap(const snap_t *s, const uint8_t owner[STORE_SNAP_OWNER_LEN]);
esp_err_t store_erase_snap(void);                /* ESP_OK also when there was none */

/* Unpair command: erases the Wi-Fi list, owner, lost, settings, ui, games and snap blobs (the pairing goes through identity_wipe). The only
 * place that erases the Wi-Fi list. Tries every key; returns the first error, ESP_OK also when there was nothing. */
esp_err_t store_erase_device_data(void);
