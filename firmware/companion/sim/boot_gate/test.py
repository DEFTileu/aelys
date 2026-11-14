"""Run the real app_main and halt bodies with host-only boundary fakes."""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
source = (ROOT / 'main' / 'app_main.c').read_text()


def function(signature):
    start = source.index(signature)
    opening = source.index('{', start)
    depth = 1
    for i in range(opening + 1, len(source)):
        if source[i] == '{':
            depth += 1
        elif source[i] == '}':
            depth -= 1
            if depth == 0:
                return source[start:i + 1]
    raise ValueError(f'unclosed function: {signature}')


prefix = r'''
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef int esp_err_t;
#define ESP_OK 0
#define portMAX_DELAY 123
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_SPIRAM 2
#define CONFIG_AELYS_METRICS_PERIOD_S 10
#define FW_VERSION "test"
#define ESP_LOGW(...) log_ignore(__VA_ARGS__)
#define ESP_LOGI(...) log_ignore(__VA_ARGS__)
#define ESP_LOGE(tag, format, ...) log_error(tag, format, __VA_ARGS__)
static const char *TAG = "test";
static jmp_buf stopped;
static int init_result, init_calls, board_calls, delays, logs, after_store;
static int identity_calls, ui_calls, net_calls, link_calls, metrics_calls;
static void log_ignore(const char *tag, const char *format, ...) { (void)tag; (void)format; }
static void log_error(const char *tag, const char *format, ...) { (void)tag; (void)format; ++logs; }
static const char *esp_err_to_name(int err) { (void)err; return "fake error"; }
static unsigned esp_psram_get_size(void) { return 0; }
static unsigned heap_caps_get_free_size(int caps) { (void)caps; return 0; }
static esp_err_t board_init(void) { ++board_calls; return ESP_OK; }
static esp_err_t store_init(void) { ++init_calls; return init_result; }
static void vTaskDelay(int ticks) { if (ticks != portMAX_DELAY) abort(); ++delays; longjmp(stopped, 1); }
typedef struct { int unused; } owner_info_t;
typedef struct { bool on; } lost_state_t;
typedef struct { int brightness; } settings_t;
typedef struct { int n; } wifi_list_t;
static owner_info_t owner;
static lost_state_t lost;
static settings_t settings;
static bool first_boot, boot_paired;
static void store_load_owner(owner_info_t *p) { (void)p; ++after_store; }
static void store_load_lost(lost_state_t *p) { (void)p; ++after_store; }
static void store_load_settings(settings_t *p) { (void)p; ++after_store; }
static void store_load_wifi(wifi_list_t *p) { (void)p; ++after_store; }
static int board_display_set_brightness(int n) { (void)n; return ESP_OK; }
static int store_load_pair(void) { return 0; }
static int store_save_pair(void) { return 0; }
static int store_erase_pair(void) { return 0; }
typedef struct { int (*load)(void), (*save)(void), (*erase)(void); } identity_store_t;
static int identity_init(const identity_store_t *s) { (void)s; ++identity_calls; return ESP_OK; }
static bool identity_paired(void) { return false; }
static unsigned uxTaskGetStackHighWaterMark(void *p) { (void)p; return 0; }
static void clear_bytes(void *p, size_t n) { memset(p, 0, n); }
#define explicit_bzero clear_bytes
static void on_ui_event(void) {}
static void boot_ui_setup(void) {}
static void lv_port_set_handler(void (*f)(void)) { (void)f; ++ui_calls; }
static int lv_port_start(void (*f)(void)) { (void)f; ++ui_calls; return ESP_OK; }
static int board_input_start(void) { return ESP_OK; }
static int store_save_wifi(void) { return 0; }
static bool lost_is_on(void) { return false; }
typedef struct { void (*load)(wifi_list_t *); int (*save)(void); bool (*lost_on)(void); } net_store_t;
static int net_start(const net_store_t *s) { (void)s; ++net_calls; return ESP_OK; }
static void on_command(void) {}
static void save_snap(void) {}
static void load_snap(void) {}
static void erase_snap(void) {}
static void lost_revision(void) {}
static void contact_phone(void) {}
static void contact_telegram(void) {}
static void net_wifi_current_ssid(void) {}
static void reset_revs(void) {}
typedef struct {
    void (*on_command)(void), (*save_snap)(void), (*load_snap)(void), (*erase_snap)(void);
    bool (*lost_on)(void);
    void (*lost_rev)(void), (*contact_phone)(void), (*contact_telegram)(void), (*current_ssid)(void);
    void (*load_wifi)(wifi_list_t *);
    void (*reset_revs)(void);
} link_deps_t;
static int link_start(const link_deps_t *d) { (void)d; ++link_calls; return ESP_OK; }
static void metrics_start(int n) { (void)n; ++metrics_calls; }
'''
suffix = r'''
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "line %d: %s\n", __LINE__, #c); return 1; } } while (0)
int main(void) {
    for (int error = 1; error <= 2; ++error) {
        init_result = error;
        if (!setjmp(stopped)) { app_main(); fprintf(stderr, "boot returned on NVS failure\n"); return 1; }
        CHECK(delays == error && logs == error && init_calls == error && board_calls == error);
        CHECK(after_store == 0 && identity_calls == 0 && ui_calls == 0 && net_calls == 0 && link_calls == 0 && metrics_calls == 0);
    }
    init_result = ESP_OK;
    app_main();
    CHECK(init_calls == 3 && board_calls == 3 && delays == 2);
    CHECK(after_store == 4 && identity_calls == 1 && ui_calls == 2 && net_calls == 1 && link_calls == 1 && metrics_calls == 1);
    puts("PASS NVS failures halt before state loads and services; success continues startup");
    return 0;
}
'''
with tempfile.TemporaryDirectory(prefix='aelys-boot-test-') as directory:
    test_source = pathlib.Path(directory) / 'boot_test.c'
    executable = pathlib.Path(directory) / 'boot_test'
    test_source.write_text(prefix + function('static void halt(') + '\n' + function('void app_main(void)') + '\n' + suffix)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(test_source), '-o', str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
