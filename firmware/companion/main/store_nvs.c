#include <stdlib.h>
#include <string.h>
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "store_nvs.h"

#define NS "aelys"

static const char *TAG = "store";

esp_err_t store_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "nvs partition unusable (%s), erasing it", esp_err_to_name(err));
        err = nvs_flash_erase(); /* the nvs partition only, never the whole flash */
        if (err == ESP_OK) err = nvs_flash_init();
    }
    return err;
}

/* Reads a blob into buf; returns its length, 0 if absent or unreadable. */
static size_t read_blob(const char *key, uint8_t *buf, size_t cap)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return 0;
    size_t len = cap;
    if (nvs_get_blob(h, key, buf, &len) != ESP_OK) len = 0;
    nvs_close(h);
    return len;
}

static esp_err_t write_blob(const char *key, const uint8_t *buf, size_t len)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(h, key, buf, len);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) ESP_LOGE(TAG, "save %s: %s", key, esp_err_to_name(err));
    return err;
}

void store_load_owner(owner_info_t *o)
{
    uint8_t b[STORE_OWNER_BLOB];
    size_t n = read_blob("owner", b, sizeof b);
    if (n && store_decode_owner(b, n, o)) return;
    if (n) ESP_LOGW(TAG, "owner blob corrupt, using factory contacts");
    owner_defaults(o);
}

esp_err_t store_save_owner(const owner_info_t *o)
{
    uint8_t b[STORE_OWNER_BLOB];
    size_t n = store_encode_owner(o, b, sizeof b);
    return n ? write_blob("owner", b, n) : ESP_ERR_INVALID_SIZE;
}

void store_load_wifi(wifi_list_t *l)
{
    uint8_t b[STORE_WIFI_BLOB];
    size_t n = read_blob("wifi", b, sizeof b);
    if (n && store_decode_wifi(b, n, l)) return;
    if (n) ESP_LOGW(TAG, "wifi blob corrupt, ignoring");
    memset(l, 0, sizeof *l);
}

esp_err_t store_save_wifi(const wifi_list_t *l)
{
    uint8_t b[STORE_WIFI_BLOB];
    size_t n = store_encode_wifi(l, b, sizeof b);
    return n ? write_blob("wifi", b, n) : ESP_ERR_INVALID_SIZE;
}

void store_load_lost(lost_state_t *s)
{
    uint8_t b[STORE_LOST_BLOB];
    size_t n = read_blob("lost", b, sizeof b);
    if (n && store_decode_lost(b, n, s)) return;
    if (n) ESP_LOGW(TAG, "lost blob corrupt, lost mode off");
    memset(s, 0, sizeof *s);
}

esp_err_t store_save_lost(const lost_state_t *s)
{
    uint8_t b[STORE_LOST_BLOB];
    size_t n = store_encode_lost(s, b, sizeof b);
    return n ? write_blob("lost", b, n) : ESP_ERR_INVALID_SIZE;
}

bool store_load_pair(pair_rec_t *p)
{
    uint8_t b[STORE_PAIR_BLOB];
    size_t n = read_blob("pair", b, sizeof b);
    bool ok = n && store_decode_pair(b, n, p);
    explicit_bzero(b, sizeof b); /* b holds the private key */
    if (!ok && n) ESP_LOGW(TAG, "pair blob corrupt, board is unpaired");
    return ok;
}

esp_err_t store_save_pair(const pair_rec_t *p)
{
    uint8_t b[STORE_PAIR_BLOB];
    size_t n = store_encode_pair(p, b, sizeof b);
    esp_err_t err = n ? write_blob("pair", b, n) : ESP_ERR_INVALID_SIZE;
    explicit_bzero(b, sizeof b);
    return err;
}

esp_err_t store_erase_pair(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_erase_key(h, "pair");
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

#define SNAP_VERSION 1
#define SNAP_BLOB (1 + sizeof(snap_t) + 4)

bool store_load_snap(snap_t *s)
{
    uint8_t *b = malloc(SNAP_BLOB); /* ~1.1 KB, only while reading */
    if (!b) return false;
    size_t n = read_blob("snap", b, SNAP_BLOB);
    uint32_t crc = n == SNAP_BLOB ? b[n - 4] | b[n - 3] << 8 | b[n - 2] << 16 | (uint32_t)b[n - 1] << 24 : 0;
    bool ok = n == SNAP_BLOB && b[0] == SNAP_VERSION && crc == store_crc32(b, n - 4);
    if (ok) memcpy(s, b + 1, sizeof *s);
    free(b);
    return ok;
}

esp_err_t store_save_snap(const snap_t *s)
{
    uint8_t *b = malloc(SNAP_BLOB);
    if (!b) return ESP_ERR_NO_MEM;
    b[0] = SNAP_VERSION;
    memcpy(b + 1, s, sizeof *s);
    uint32_t crc = store_crc32(b, SNAP_BLOB - 4);
    for (int i = 0; i < 4; i++) b[SNAP_BLOB - 4 + i] = (uint8_t)(crc >> (8 * i));
    esp_err_t err = write_blob("snap", b, SNAP_BLOB);
    free(b);
    return err;
}
