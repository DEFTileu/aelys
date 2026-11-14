#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "nvs.h"
#include "store_nvs.h"

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); exit(1); } } while (0)
static unsigned char saved[STORE_SNAP_OWNED_BLOB + 16], pending[sizeof saved];
static size_t saved_len, pending_len;
static int writes, commits, erases;
static enum { NONE, OPEN_READ, OPEN_WRITE, GET, SET, COMMIT } fail;

const char *esp_err_to_name(esp_err_t err) { (void)err; return "injected"; }
esp_err_t nvs_flash_init(void) { return ESP_OK; }
esp_err_t nvs_flash_erase(void) { ++erases; return ESP_FAIL; }
void owner_defaults(owner_info_t *o) { memset(o, 0, sizeof *o); }
void settings_defaults(settings_t *s) { memset(s, 0, sizeof *s); }
esp_err_t nvs_open(const char *ns, nvs_open_mode_t mode, nvs_handle_t *h) {
    CHECK(strcmp(ns, "aelys") == 0);
    if ((mode == NVS_READONLY && fail == OPEN_READ) || (mode == NVS_READWRITE && fail == OPEN_WRITE)) return ESP_FAIL;
    *h = mode == NVS_READONLY ? 1 : 2; pending_len = 0; return ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t h, const char *key, void *out, size_t *len) {
    CHECK(h == 1 && strcmp(key, "snap") == 0);
    if (fail == GET) return ESP_FAIL;
    if (!saved_len) return ESP_ERR_NVS_NOT_FOUND;
    if (*len < saved_len) { *len = saved_len; return ESP_ERR_INVALID_SIZE; }
    memcpy(out, saved, saved_len); *len = saved_len; return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t h, const char *key, const void *data, size_t len) {
    CHECK(h == 2 && strcmp(key, "snap") == 0 && len <= sizeof pending);
    ++writes; if (fail == SET) return ESP_FAIL;
    memcpy(pending, data, len); pending_len = len; return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t h) {
    CHECK(h == 2); ++commits; if (fail == COMMIT) return ESP_FAIL;
    memcpy(saved, pending, pending_len); saved_len = pending_len; return ESP_OK;
}
esp_err_t nvs_erase_key(nvs_handle_t h, const char *key) { (void)h; (void)key; ++erases; return ESP_FAIL; }
void nvs_close(nvs_handle_t h) { CHECK(h == 1 || h == 2); pending_len = 0; }

static void rejected_untouched(const unsigned char *owner) {
    snap_t out, before; memset(&out, 0xa5, sizeof out); memcpy(&before, &out, sizeof out);
    CHECK(!store_load_snap(&out, owner)); CHECK(memcmp(&out, &before, sizeof out) == 0);
}
int main(void) {
    unsigned char a[STORE_SNAP_OWNER_LEN] = {4, 1}, b[STORE_SNAP_OWNER_LEN] = {4, 2};
    snap_t in = {0}, out;
    in.generated = 1794493920; in.has_task = true; strcpy(in.task.id, "task-a");
    strcpy(in.task.title, "Saved for A"); in.unread = 3; in.focus.status = FOCUS_PAUSED; in.focus.elapsed_s = 123;
    CHECK(store_save_snap(&in, a) == ESP_OK);
    CHECK(saved_len == STORE_SNAP_OWNED_BLOB && writes == 1 && commits == 1);
    memset(&out, 0xa5, sizeof out); CHECK(store_load_snap(&out, a));
    CHECK(out.generated == 1794493920 && out.has_task && !strcmp(out.task.id, "task-a"));
    CHECK(!strcmp(out.task.title, "Saved for A") && out.unread == 3 && out.focus.status == FOCUS_PAUSED && out.focus.elapsed_s == 123);
    puts("PASS save A / load A");
    int before_writes = writes, before_commits = commits;
    rejected_untouched(b); rejected_untouched(NULL);
    CHECK(writes == before_writes && commits == before_commits);
    puts("PASS A rejected for B and unpaired; output unchanged");
    unsigned char original[sizeof saved]; size_t original_len = saved_len; memcpy(original, saved, saved_len);
    saved[20] ^= 1; rejected_untouched(a); memcpy(saved, original, original_len);
    --saved_len; rejected_untouched(a); saved_len = original_len;
    saved_len = sizeof saved; rejected_untouched(a); memcpy(saved, original, original_len); saved_len = original_len;
    puts("PASS corrupted, truncated and oversized blobs rejected; output unchanged");
    fail = OPEN_READ; rejected_untouched(a); fail = GET; rejected_untouched(a); fail = NONE;
    CHECK(writes == before_writes && commits == before_commits);
    puts("PASS read open/get failures; output unchanged");
    fail = OPEN_WRITE; CHECK(store_save_snap(&in, a) == ESP_FAIL);
    fail = SET; CHECK(store_save_snap(&in, a) == ESP_FAIL);
    fail = COMMIT; CHECK(store_save_snap(&in, a) == ESP_FAIL);
    fail = NONE; CHECK(saved_len == original_len && !memcmp(saved, original, original_len));
    CHECK(store_load_snap(&out, a) && out.generated == in.generated);
    puts("PASS write open/set/commit failures propagated");
    saved_len = store_encode_snap(&in, saved, sizeof saved); CHECK(saved_len == STORE_SNAP_BLOB);
    unsigned char legacy[STORE_SNAP_BLOB]; memcpy(legacy, saved, saved_len);
    before_writes = writes; before_commits = commits;
    rejected_untouched(a); CHECK(writes == before_writes && commits == before_commits && saved_len == sizeof legacy && !memcmp(saved, legacy, sizeof legacy));
    CHECK(erases == 0);
    puts("PASS untagged legacy hidden without writes; output unchanged");
    return 0;
}

void owned_nvs_explicit_bzero(void *p, size_t n) { volatile unsigned char *v = p; while (n--) *v++ = 0; }
