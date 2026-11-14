#include "action_journal_store.h"
#include "nvs.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned char disk[800], staged[800];
static size_t disk_len, staged_len;
static int open_error, missing_namespace, write_open_error, read_error, data_read_error, set_error, commit_error, commit_writes, reads, writes;
esp_err_t nvs_open(const char *ns, nvs_open_mode_t mode, nvs_handle_t *h) {
    assert(!strcmp(ns, "aelys")); (void)mode; *h = 1;
    if (open_error || (write_open_error && mode == NVS_READWRITE)) return ESP_FAIL;
    return missing_namespace && mode == NVS_READONLY ? ESP_ERR_NVS_NOT_FOUND : ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t h, const char *key, void *out, size_t *len) {
    assert(h == 1 && !strcmp(key, "action_journal")); ++reads;
    if (read_error || (data_read_error && out)) return ESP_FAIL;
    if (!disk_len) return ESP_ERR_NVS_NOT_FOUND;
    if (!out) { *len = disk_len; return ESP_OK; }
    if (*len < disk_len) { *len = disk_len; return ESP_ERR_NVS_INVALID_LENGTH; }
    memcpy(out, disk, disk_len); *len = disk_len; return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t h, const char *key, const void *data, size_t len) {
    assert(h == 1 && !strcmp(key, "action_journal") && len <= sizeof staged); ++writes;
    if (set_error) return ESP_FAIL;
    memcpy(staged, data, len); staged_len = len; return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t h) {
    assert(h == 1);
    if (!commit_error || commit_writes) { memcpy(disk, staged, staged_len); disk_len = staged_len; }
    return commit_error ? ESP_FAIL : ESP_OK;
}
void nvs_close(nvs_handle_t h) { assert(h == 1); }
static action_journal_binding_t owner(void) {
    action_journal_binding_t b = {0}; b.owner[0] = 4; b.owner[64] = 9;
    strcpy(b.device_id, "device-1"); strcpy(b.api_origin, "https://example.test"); return b;
}
static action_journal_t journal(void) {
    action_journal_t j = {0}; j.count = 1;
    strcpy(j.records[0].id, "5f0c2a7e-3b1d-4c8e-9a6f-2d7b1e4c9a10");
    j.records[0].kind = ACTION_JOURNAL_TASK_COMPLETE; strcpy(j.records[0].target, "task-1"); return j;
}
static void expect_load(action_journal_store_t *s, action_journal_binding_t *b, action_journal_store_result_t expected) {
    action_journal_t out, before; memset(&out, 0xa5, sizeof out); before = out;
    assert(action_journal_store_load(s, b, &out) == expected);
    if (expected != ACTION_JOURNAL_STORE_OK) assert(!memcmp(&out, &before, sizeof out));
    else assert(out.count == 1 && !strcmp(out.records[0].target, "task-1"));
}
int main(void) {
    action_journal_store_t s = ACTION_JOURNAL_STORE_INIT;
    action_journal_binding_t b = owner(), other = b; action_journal_t j = journal();
    expect_load(&s, &b, ACTION_JOURNAL_STORE_NOT_FOUND);
    missing_namespace = 1; expect_load(&s, &b, ACTION_JOURNAL_STORE_NOT_FOUND); missing_namespace = 0;
    open_error = 1; expect_load(&s, &b, ACTION_JOURNAL_STORE_IO_ERROR);
    assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_IO_ERROR); open_error = 0;
    read_error = 1; expect_load(&s, &b, ACTION_JOURNAL_STORE_IO_ERROR);
    assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_IO_ERROR); read_error = 0;
    assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_OK);
    data_read_error = 1; expect_load(&s, &b, ACTION_JOURNAL_STORE_IO_ERROR);
    assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_IO_ERROR); data_read_error = 0;
    write_open_error = 1; assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_IO_ERROR); write_open_error = 0;
    action_journal_store_t reboot = ACTION_JOURNAL_STORE_INIT;
    expect_load(&reboot, &b, ACTION_JOURNAL_STORE_OK);
    other.owner[64]++; expect_load(&s, &other, ACTION_JOURNAL_STORE_OWNER_MISMATCH);
    assert(action_journal_store_save(&s, &other, &j) == ACTION_JOURNAL_STORE_OWNER_MISMATCH);
    other = b; strcpy(other.device_id, "device-2"); expect_load(&s, &other, ACTION_JOURNAL_STORE_OWNER_MISMATCH);
    other = b; strcpy(other.api_origin, "https://other.test"); expect_load(&s, &other, ACTION_JOURNAL_STORE_OWNER_MISMATCH);
    disk[300] ^= 1; expect_load(&s, &b, ACTION_JOURNAL_STORE_INVALID);
    assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_INVALID); disk[300] ^= 1;
    size_t saved_len = disk_len; disk_len = 599; expect_load(&s, &b, ACTION_JOURNAL_STORE_INVALID);
    disk_len = 601; expect_load(&s, &b, ACTION_JOURNAL_STORE_INVALID); disk_len = saved_len;
    other = b; other.owner[0] = 0; expect_load(&s, &other, ACTION_JOURNAL_STORE_INVALID);
    j.count = 5; assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_INVALID); j = journal();
    set_error = 1; assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_IO_ERROR); set_error = 0;
    int prior = writes; assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_IO_ERROR && writes == prior);
    expect_load(&s, &b, ACTION_JOURNAL_STORE_IO_ERROR);
    s = (action_journal_store_t)ACTION_JOURNAL_STORE_INIT; commit_error = 1; commit_writes = 0;
    assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_IO_ERROR);
    commit_error = 0; expect_load(&s, &b, ACTION_JOURNAL_STORE_IO_ERROR);
    s = (action_journal_store_t)ACTION_JOURNAL_STORE_INIT; commit_error = 1; commit_writes = 1;
    strcpy(j.records[0].target, "task-2"); assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_IO_ERROR);
    commit_error = 0; prior = writes; assert(action_journal_store_save(&s, &b, &j) == ACTION_JOURNAL_STORE_IO_ERROR && writes == prior);
    reboot = (action_journal_store_t)ACTION_JOURNAL_STORE_INIT;
    action_journal_t out; assert(action_journal_store_load(&reboot, &b, &out) == ACTION_JOURNAL_STORE_OK);
    assert(!strcmp(out.records[0].target, "task-2"));
    printf("action journal store tests passed (reads=%d writes=%d)\n", reads, writes); return 0;
}
