#include <stdio.h>
#include <string.h>
#include "codec_util.h"
#include "esp_log.h"
#include "identity.h"
#include "psa/crypto.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#ifdef CONFIG_AELYS_IDENTITY_SELFTEST
#include "vectors.h"
#endif

#define PUB_LEN 65
#define BLOB_VERSION 1
#define BLOB_MAX 192
#define GCM_NONCE 12
#define GCM_TAG 16
#define SAS_ID_MAX 64
#define SECRET_MAX 128
#define ECIES_ALG PSA_ALG_KEY_AGREEMENT(PSA_ALG_ECDH, PSA_ALG_HKDF(PSA_ALG_SHA_256))

static const char *TAG = "identity";

static const identity_store_t *st;
static psa_key_id_t key;                 /* the paired key, volatile, never exportable */
static uint8_t pub[PUB_LEN];
static char dev_id[40];
static char api_url[129];
static psa_key_id_t pend;                /* the key being paired: RAM only until commit */
static uint8_t pend_pub[PUB_LEN];
static char pend_url[129];

/* One recursive lock around every entry point: the net task (USB pairing) and the link task (sign-in) both come
 * here. Created by identity_init, which runs in app_main before either task exists; a NULL lock means "single task". */
static SemaphoreHandle_t mu;
static void lock(void) { if (mu) xSemaphoreTakeRecursive(mu, portMAX_DELAY); }
static void unlock(void) { if (mu) xSemaphoreGiveRecursive(mu); }

static void key_attrs(psa_key_attributes_t *a)
{
    psa_set_key_type(a, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
    psa_set_key_bits(a, 256);
    psa_set_key_usage_flags(a, PSA_KEY_USAGE_SIGN_MESSAGE | PSA_KEY_USAGE_DERIVE);
    psa_set_key_algorithm(a, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
    psa_set_key_enrollment_algorithm(a, ECIES_ALG);
}

static esp_err_t import_active(const uint8_t priv[32], psa_key_id_t *id, uint8_t pubkey[PUB_LEN])
{
    psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
    key_attrs(&a);
    psa_status_t s = psa_import_key(&a, priv, 32, id);
    psa_reset_key_attributes(&a);
    if (s != PSA_SUCCESS) return ESP_ERR_INVALID_ARG;
    size_t n = 0;
    s = psa_export_public_key(*id, pubkey, PUB_LEN, &n);
    if (s != PSA_SUCCESS || n != PUB_LEN) { psa_destroy_key(*id); *id = PSA_KEY_ID_NULL; return ESP_FAIL; }
    return ESP_OK;
}

static void drop_key(void)
{
    if (key) psa_destroy_key(key);
    key = PSA_KEY_ID_NULL;
    memset(pub, 0, sizeof pub);
    dev_id[0] = api_url[0] = '\0';
}

static esp_err_t init_(const identity_store_t *store)
{
    if (!store || !store->load || !store->save || !store->erase) return ESP_ERR_INVALID_ARG;
    if (psa_crypto_init() != PSA_SUCCESS) return ESP_FAIL;
    st = store;
    identity_pair_cancel();
    drop_key();
    pair_rec_t r;
    if (!st->load(&r)) return ESP_OK;
    esp_err_t err = strncmp(r.api_url, "https://", 8) == 0 ? import_active(r.priv, &key, pub) : ESP_ERR_INVALID_ARG;
    if (err == ESP_OK) {
        strcpy(dev_id, r.device_id);
        strcpy(api_url, r.api_url);
    } else {
        ESP_LOGW(TAG, "stored pairing unusable, board is unpaired");
    }
    explicit_bzero(&r, sizeof r);
    return ESP_OK;
}


static esp_err_t pub_b64_(char out[88])
{
    const uint8_t *p = pend ? pend_pub : key ? pub : NULL;
    if (!p) return ESP_ERR_INVALID_STATE;
    return b64url_encode(p, PUB_LEN, out, 88) ? ESP_OK : ESP_FAIL;
}

static esp_err_t pair_begin_(const char *url)
{
    if (!url || strncmp(url, "https://", 8) != 0 || strlen(url) > 128) return ESP_ERR_INVALID_ARG;
    if (!st) return ESP_ERR_INVALID_STATE;
    identity_pair_cancel();
    psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&a, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
    psa_set_key_bits(&a, 256);
    psa_set_key_usage_flags(&a, PSA_KEY_USAGE_EXPORT); /* commit exports the scalar once, for the one NVS write */
    psa_status_t s = psa_generate_key(&a, &pend);
    psa_reset_key_attributes(&a);
    if (s != PSA_SUCCESS) { pend = PSA_KEY_ID_NULL; return ESP_FAIL; }
    size_t n = 0;
    if (psa_export_public_key(pend, pend_pub, PUB_LEN, &n) != PSA_SUCCESS || n != PUB_LEN) {
        identity_pair_cancel();
        return ESP_FAIL;
    }
    strcpy(pend_url, url);
    return ESP_OK;
}

static void pair_cancel_(void)
{
    if (pend) psa_destroy_key(pend);
    pend = PSA_KEY_ID_NULL;
    memset(pend_pub, 0, sizeof pend_pub);
    pend_url[0] = '\0';
}

/* HMAC-SHA256(secret, "aelys-sas-v1|" id "|" pub65), first 4 bytes big-endian mod 1e6: same as the backend's sas_code. */
static esp_err_t sas_for(const char *secret, const char *id, const uint8_t p[PUB_LEN], char sas[7])
{
    size_t sl = secret ? strlen(secret) : 0, il = id ? strlen(id) : 0;
    if (!sl || sl > SECRET_MAX || il > SAS_ID_MAX) return ESP_ERR_INVALID_ARG;
    uint8_t msg[13 + SAS_ID_MAX + 1 + PUB_LEN];
    size_t n = 0;
    memcpy(msg, "aelys-sas-v1|", 13); n = 13;
    memcpy(msg + n, id, il); n += il;
    msg[n++] = '|';
    memcpy(msg + n, p, PUB_LEN); n += PUB_LEN;

    psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&a, PSA_KEY_TYPE_HMAC);
    psa_set_key_bits(&a, sl * 8);
    psa_set_key_usage_flags(&a, PSA_KEY_USAGE_SIGN_MESSAGE);
    psa_set_key_algorithm(&a, PSA_ALG_HMAC(PSA_ALG_SHA_256));
    psa_key_id_t k;
    psa_status_t s = psa_import_key(&a, (const uint8_t *)secret, sl, &k);
    psa_reset_key_attributes(&a);
    if (s != PSA_SUCCESS) return ESP_FAIL;
    uint8_t mac[32]; size_t ml = 0;
    s = psa_mac_compute(k, PSA_ALG_HMAC(PSA_ALG_SHA_256), msg, n, mac, sizeof mac, &ml);
    psa_destroy_key(k);
    uint32_t v = (uint32_t)mac[0] << 24 | (uint32_t)mac[1] << 16 | (uint32_t)mac[2] << 8 | mac[3];
    bool good = s == PSA_SUCCESS && ml == sizeof mac;
    explicit_bzero(mac, sizeof mac);
    if (!good) return ESP_FAIL;
    snprintf(sas, 7, "%06u", (unsigned)(v % 1000000u));
    return ESP_OK;
}

static esp_err_t pair_code_(const char *secret, const char *pairing_id, char sas[7])
{
    if (!pend) return ESP_ERR_INVALID_STATE;
    return sas_for(secret, pairing_id, pend_pub, sas);
}

static esp_err_t pair_commit_(const char *device_id)
{
    if (!pend) return ESP_ERR_INVALID_STATE;
    if (!device_id || !*device_id || strlen(device_id) >= sizeof dev_id) return ESP_ERR_INVALID_ARG;
    pair_rec_t r;
    memset(&r, 0, sizeof r);
    strcpy(r.device_id, device_id);
    strcpy(r.api_url, pend_url);
    size_t n = 0;
    psa_key_id_t nk = PSA_KEY_ID_NULL;
    uint8_t npub[PUB_LEN];
    esp_err_t err = ESP_FAIL;
    if (psa_export_key(pend, r.priv, sizeof r.priv, &n) == PSA_SUCCESS && n == sizeof r.priv)
        err = import_active(r.priv, &nk, npub);      /* import first: a failure here leaves the old pairing intact */
    if (err == ESP_OK) {
        err = st->save(&r);                          /* the one NVS write */
        if (err != ESP_OK) psa_destroy_key(nk);
    }
    explicit_bzero(&r.priv, sizeof r.priv);
    if (err != ESP_OK) return err;
    drop_key();
    key = nk;
    memcpy(pub, npub, PUB_LEN);
    strcpy(dev_id, r.device_id);
    strcpy(api_url, r.api_url);
    identity_pair_cancel();
    return ESP_OK;
}

static esp_err_t sign_(const char *msg, char sig_b64[87])
{
    if (!key) return ESP_ERR_INVALID_STATE;
    if (!msg) return ESP_ERR_INVALID_ARG;
    uint8_t sig[64]; size_t n = 0;
    psa_status_t s = psa_sign_message(key, PSA_ALG_ECDSA(PSA_ALG_SHA_256), (const uint8_t *)msg, strlen(msg),
                                      sig, sizeof sig, &n);
    if (s != PSA_SUCCESS || n != sizeof sig) return ESP_FAIL; /* raw r||s */
    return b64url_encode(sig, n, sig_b64, 87) ? ESP_OK : ESP_FAIL;
}

static esp_err_t wifi_decrypt_(const uint8_t *blob, size_t n, char ssid[33], char pass[65])
{
    /* version, eph point, nonce, at least a 3-byte plaintext, tag */
    if (!key) return ESP_ERR_INVALID_STATE;
    if (!blob || n < 1 + PUB_LEN + GCM_NONCE + 3 + GCM_TAG || n > BLOB_MAX || blob[0] != BLOB_VERSION || blob[1] != 0x04)
        return ESP_ERR_INVALID_ARG;
    const uint8_t *eph = blob + 1, *nonce = eph + PUB_LEN, *ct = nonce + GCM_NONCE;
    size_t ctlen = n - (size_t)(ct - blob);               /* ciphertext + tag */

    uint8_t salt[2 * PUB_LEN];
    memcpy(salt, eph, PUB_LEN);
    memcpy(salt + PUB_LEN, pub, PUB_LEN);
    psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
    psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&a, PSA_KEY_TYPE_AES);
    psa_set_key_bits(&a, 256);
    psa_set_key_usage_flags(&a, PSA_KEY_USAGE_DECRYPT);
    psa_set_key_algorithm(&a, PSA_ALG_GCM);
    psa_key_id_t aes = PSA_KEY_ID_NULL;
    psa_status_t s = psa_key_derivation_setup(&op, ECIES_ALG);
    if (s == PSA_SUCCESS) s = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, salt, sizeof salt);
    if (s == PSA_SUCCESS) s = psa_key_derivation_key_agreement(&op, PSA_KEY_DERIVATION_INPUT_SECRET, key, eph, PUB_LEN);
    if (s == PSA_SUCCESS) s = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_INFO, (const uint8_t *)"aelys-wifi-v1", 13);
    if (s == PSA_SUCCESS) s = psa_key_derivation_output_key(&a, &op, &aes);
    psa_key_derivation_abort(&op);
    psa_reset_key_attributes(&a);
    if (s != PSA_SUCCESS) { ESP_LOGW(TAG, "wifi key derivation failed (%d)", (int)s); return ESP_FAIL; }

    uint8_t plain[BLOB_MAX]; size_t pl = 0;
    s = psa_aead_decrypt(aes, PSA_ALG_GCM, nonce, GCM_NONCE, (const uint8_t *)dev_id, strlen(dev_id), ct, ctlen,
                         plain, sizeof plain, &pl);
    psa_destroy_key(aes);
    esp_err_t err = ESP_FAIL;
    if (s == PSA_SUCCESS && wifi_plain_parse(plain, pl, ssid, pass)) err = ESP_OK;
    explicit_bzero(plain, sizeof plain);
    return err;
}

static esp_err_t wipe_(void)
{
    if (!st) return ESP_ERR_INVALID_STATE;
    esp_err_t err = st->erase();
    if (err != ESP_OK) return err;                      /* the record is still there: stay paired */
    identity_pair_cancel();
    drop_key();
    return ESP_OK;
}

/* ---- public API: every call takes the lock ---- */

bool identity_paired(void)
{
    lock();
    bool r = key != PSA_KEY_ID_NULL;
    unlock();
    return r;
}

/* The pointers below are stable only until the next pair/wipe: a task that outlives those copies with identity_ids(). */
const char *identity_device_id(void)
{
    lock();
    const char *r = dev_id;
    unlock();
    return r;
}

const char *identity_api_url(void)
{
    lock();
    const char *r = api_url;
    unlock();
    return r;
}

esp_err_t identity_init(const identity_store_t *store)
{
    if (!mu && !(mu = xSemaphoreCreateRecursiveMutex())) return ESP_ERR_NO_MEM;
    lock();
    esp_err_t r = init_(store);
    unlock();
    return r;
}

esp_err_t identity_pub_b64(char out[88])
{
    lock();
    esp_err_t r = pub_b64_(out);
    unlock();
    return r;
}

esp_err_t identity_pair_begin(const char *url)
{
    lock();
    esp_err_t r = pair_begin_(url);
    unlock();
    return r;
}

void identity_pair_cancel(void)
{
    lock();
    pair_cancel_();
    unlock();
}

esp_err_t identity_pair_code(const char *secret, const char *pairing_id, char sas[7])
{
    lock();
    esp_err_t r = pair_code_(secret, pairing_id, sas);
    unlock();
    return r;
}

esp_err_t identity_pair_commit(const char *device_id)
{
    lock();
    esp_err_t r = pair_commit_(device_id);
    unlock();
    return r;
}

esp_err_t identity_sign(const char *msg, char sig_b64[87])
{
    lock();
    esp_err_t r = sign_(msg, sig_b64);
    unlock();
    return r;
}

esp_err_t identity_wifi_decrypt(const uint8_t *blob, size_t n, char ssid[33], char pass[65])
{
    lock();
    esp_err_t r = wifi_decrypt_(blob, n, ssid, pass);
    unlock();
    return r;
}

esp_err_t identity_wipe(void)
{
    lock();
    esp_err_t r = wipe_();
    unlock();
    return r;
}

esp_err_t identity_ids(char device_id[40], char url[129])
{
    lock();
    esp_err_t r = key ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (r == ESP_OK) {
        memcpy(device_id, dev_id, sizeof dev_id);
        memcpy(url, api_url, sizeof api_url);
    }
    unlock();
    return r;
}

#ifdef CONFIG_AELYS_IDENTITY_SELFTEST
static pair_rec_t st_rec;
static int st_saves, st_erases;
static bool st_load(pair_rec_t *r)
{
    memset(r, 0, sizeof *r);
    strcpy(r->device_id, VEC_DEVICE_ID);
    strcpy(r->api_url, "https://selftest.invalid");
    memcpy(r->priv, VEC_DEVICE_PRIV, 32);
    return true;
}
static esp_err_t st_save(const pair_rec_t *r) { st_rec = *r; st_saves++; return ESP_OK; }
static esp_err_t st_erase(void) { st_erases++; return ESP_OK; }

#define T(cond) do { if (!(cond)) { ESP_LOGE(TAG, "selftest check failed at line %d: %s", __LINE__, #cond); ok = false; } } while (0)

static void selftest_run(void)
{
    static const identity_store_t ram = {.load = st_load, .save = st_save, .erase = st_erase}; /* RAM only: no NVS */
    bool ok = true;
    char ssid[33], pass[65], sas[7], sig[87], b[88];
    T(identity_init(&ram) == ESP_OK);
    T(identity_paired() && !strcmp(identity_device_id(), VEC_DEVICE_ID));
    T(identity_pub_b64(b) == ESP_OK && strlen(b) == 87);
    T(memcmp(pub, VEC_DEVICE_PUB, PUB_LEN) == 0);

    T(sas_for(VEC_SECRET, VEC_PAIRING_ID, VEC_DEVICE_PUB, sas) == ESP_OK && !strcmp(sas, VEC_SAS));
    T(identity_wifi_decrypt(VEC_BLOB, VEC_BLOB_LEN, ssid, pass) == ESP_OK && !strcmp(ssid, VEC_SSID) && !strcmp(pass, VEC_PASS));
    T(identity_wifi_decrypt(VEC_BLOB_WRONG_AAD, VEC_BLOB_WRONG_AAD_LEN, ssid, pass) != ESP_OK);
    uint8_t bad[VEC_BLOB_LEN];
    memcpy(bad, VEC_BLOB, sizeof bad);
    bad[sizeof bad - 1] ^= 1;                           /* flipped tag bit */
    T(identity_wifi_decrypt(bad, sizeof bad, ssid, pass) != ESP_OK);
    T(identity_wifi_decrypt(VEC_BLOB, VEC_BLOB_LEN - 1, ssid, pass) != ESP_OK);

    T(identity_sign(VEC_LOGIN_MSG, sig) == ESP_OK && strlen(sig) == 86);
    ESP_LOGW(TAG, "selftest sig=%s", sig);               /* checked off-board: companion_vectors.py --verify-sig */

    /* pairing lifecycle against the RAM store: begin -> code -> commit swaps the key, one save, no NVS */
    T(identity_pair_begin("http://x") == ESP_ERR_INVALID_ARG);
    T(identity_pair_commit("x") == ESP_ERR_INVALID_STATE);
    T(identity_pair_begin("https://selftest.invalid") == ESP_OK);
    T(identity_pub_b64(b) == ESP_OK && memcmp(pend_pub, VEC_DEVICE_PUB, PUB_LEN) != 0);
    T(identity_pair_code(VEC_SECRET, VEC_PAIRING_ID, sas) == ESP_OK && strlen(sas) == 6 && strcmp(sas, VEC_SAS) != 0);
    identity_pair_cancel();
    T(identity_pair_code(VEC_SECRET, VEC_PAIRING_ID, sas) == ESP_ERR_INVALID_STATE);
    T(identity_pair_begin("https://selftest.invalid") == ESP_OK);
    uint8_t newpub[PUB_LEN];
    memcpy(newpub, pend_pub, PUB_LEN);
    T(identity_pair_commit("selftest-device") == ESP_OK && st_saves == 1);
    T(!strcmp(identity_device_id(), "selftest-device") && memcmp(pub, newpub, PUB_LEN) == 0);
    T(identity_sign("x", sig) == ESP_OK);
    T(identity_wipe() == ESP_OK && st_erases == 1 && !identity_paired() && identity_sign("x", sig) == ESP_ERR_INVALID_STATE);
    explicit_bzero(&st_rec, sizeof st_rec);

    ESP_LOGW(TAG, "identity selftest %s", ok ? "PASS" : "FAIL");
}

/* The main task's 3.5 KB stack is too small for P-256 work: run on a task of the size the link task will need. */
static void selftest_task(void *arg)
{
    selftest_run();
    ESP_LOGW(TAG, "selftest stack_hwm=%u of 8192", (unsigned)uxTaskGetStackHighWaterMark(NULL));
    xSemaphoreGive((SemaphoreHandle_t)arg);
    vTaskDelete(NULL);
}

void identity_selftest(void)
{
    SemaphoreHandle_t done = xSemaphoreCreateBinary();
    if (!done || xTaskCreate(selftest_task, "idtest", 8192, done, 5, NULL) != pdPASS) {
        ESP_LOGW(TAG, "identity selftest FAIL (no task)");
        return;
    }
    xSemaphoreTake(done, portMAX_DELAY);
    vSemaphoreDelete(done);
}
#endif
