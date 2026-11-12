#pragma once
/* The board's identity towards the Aelys backend: one P-256 key (PSA volatile key, imported from the pair
 * record), the pairing SAS code and Wi-Fi ECIES decryption. Persistence is injected, like net_store_t.
 * Single-threaded: call from one task (the link task) only. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "store_codec.h"

typedef struct {
    bool (*load)(pair_rec_t *);
    esp_err_t (*save)(const pair_rec_t *);
    esp_err_t (*erase)(void);
} identity_store_t;

/* psa_crypto_init, load the record, import its key as a volatile PSA key. No record or a bad one: unpaired. */
esp_err_t identity_init(const identity_store_t *st);
bool identity_paired(void);
const char *identity_device_id(void);  /* "" when unpaired */
const char *identity_api_url(void);    /* "" when unpaired */
/* Public key (uncompressed point, base64url, 87 chars + NUL) of the pending key during pairing, else of the current key. */
esp_err_t identity_pub_b64(char out[88]);
/* New key in RAM only. ESP_ERR_INVALID_ARG unless api_url starts with "https://" and is <= 128 chars. */
esp_err_t identity_pair_begin(const char *api_url);
/* Six-digit SAS over the pending key's public point; ESP_ERR_INVALID_STATE without a pending key. */
esp_err_t identity_pair_code(const char *secret, const char *pairing_id, char sas[7]);
/* One NVS write (key + device_id + api_url); replaces any old pairing. On failure the old pairing is kept. */
esp_err_t identity_pair_commit(const char *device_id);
void      identity_pair_cancel(void);
/* ES256 over msg, raw r||s as base64url (86 chars + NUL). ESP_ERR_INVALID_STATE when unpaired. */
esp_err_t identity_sign(const char *msg, char sig_b64[87]);
/* Decrypts a Wi-Fi ECIES blob (see docs/companion-protocol.md) with the current key; AAD is the device id. */
esp_err_t identity_wifi_decrypt(const uint8_t *blob, size_t n, char ssid[33], char pass[65]);
/* Erase the record and destroy the key; unpaired afterwards. */
esp_err_t identity_wipe(void);

#ifdef CONFIG_AELYS_IDENTITY_SELFTEST
/* Board check against the generated vectors, RAM only (never touches NVS). Logs "identity selftest PASS|FAIL". */
void identity_selftest(void);
#endif
