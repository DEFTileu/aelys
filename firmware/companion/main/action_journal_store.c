#include "action_journal_store.h"
#include "nvs.h"
#include <string.h>

#define JOURNAL_NAMESPACE "aelys"
#define JOURNAL_KEY "action_journal"

/* Validate the requested binding through the codec, including bounded strings. */
static bool binding_valid(const action_journal_binding_t *binding)
{
    action_journal_t empty = {0};
    uint8_t blob[ACTION_JOURNAL_BLOB_SIZE];
    return action_journal_encode(&empty, binding, blob, sizeof blob) == sizeof blob;
}

action_journal_store_result_t action_journal_store_load(action_journal_store_t *store,
    const action_journal_binding_t *binding, action_journal_t *out)
{
    if (!store || !out || !binding_valid(binding)) return ACTION_JOURNAL_STORE_INVALID;
    if (store->uncertain) return ACTION_JOURNAL_STORE_IO_ERROR;
    nvs_handle_t handle;
    esp_err_t err = nvs_open(JOURNAL_NAMESPACE, NVS_READONLY, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) return ACTION_JOURNAL_STORE_NOT_FOUND;
    if (err != ESP_OK) return ACTION_JOURNAL_STORE_IO_ERROR;
    size_t len = 0;
    err = nvs_get_blob(handle, JOURNAL_KEY, NULL, &len);
    if (err != ESP_OK) {
        nvs_close(handle);
        return err == ESP_ERR_NVS_NOT_FOUND ? ACTION_JOURNAL_STORE_NOT_FOUND : ACTION_JOURNAL_STORE_IO_ERROR;
    }
    if (len != ACTION_JOURNAL_BLOB_SIZE) { nvs_close(handle); return ACTION_JOURNAL_STORE_INVALID; }
    uint8_t blob[ACTION_JOURNAL_BLOB_SIZE];
    err = nvs_get_blob(handle, JOURNAL_KEY, blob, &len);
    nvs_close(handle);
    if (err != ESP_OK) return ACTION_JOURNAL_STORE_IO_ERROR;
    if (len != sizeof blob) return ACTION_JOURNAL_STORE_INVALID;

    /* Decode with the stored binding first. Only a fully canonical, valid
     * blob can be classified as foreign; corruption is never a mismatch. */
    action_journal_binding_t embedded;
    memcpy(embedded.owner, blob + 6, sizeof embedded.owner);
    memcpy(embedded.device_id, blob + 71, sizeof embedded.device_id);
    memcpy(embedded.api_origin, blob + 111, sizeof embedded.api_origin);
    action_journal_t decoded;
    if (!action_journal_decode(blob, sizeof blob, &embedded, &decoded)) return ACTION_JOURNAL_STORE_INVALID;
    if (!action_journal_decode(blob, sizeof blob, binding, &decoded)) return ACTION_JOURNAL_STORE_OWNER_MISMATCH;
    *out = decoded;
    return ACTION_JOURNAL_STORE_OK;
}

action_journal_store_result_t action_journal_store_save(action_journal_store_t *store,
    const action_journal_binding_t *binding, const action_journal_t *journal)
{
    if (!store) return ACTION_JOURNAL_STORE_INVALID;
    if (store->uncertain) return ACTION_JOURNAL_STORE_IO_ERROR;
    uint8_t blob[ACTION_JOURNAL_BLOB_SIZE];
    if (action_journal_encode(journal, binding, blob, sizeof blob) != sizeof blob) return ACTION_JOURNAL_STORE_INVALID;
    action_journal_t old;
    action_journal_store_result_t status = action_journal_store_load(store, binding, &old);
    if (status != ACTION_JOURNAL_STORE_OK && status != ACTION_JOURNAL_STORE_NOT_FOUND) return status;
    nvs_handle_t handle;
    if (nvs_open(JOURNAL_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) return ACTION_JOURNAL_STORE_IO_ERROR;
    esp_err_t err = nvs_set_blob(handle, JOURNAL_KEY, blob, sizeof blob);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    if (err != ESP_OK) { store->uncertain = true; return ACTION_JOURNAL_STORE_IO_ERROR; }
    return ACTION_JOURNAL_STORE_OK;
}
