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
#include <stdio.h>
#include <stdlib.h>
typedef int esp_err_t;
#define ESP_OK 0
#define portMAX_DELAY 123
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_SPIRAM 2
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
static int owner, init_result, init_calls, board_calls, delays, after_store;
static jmp_buf stopped;
static int board_init(void) { ++board_calls; return ESP_OK; }
static int store_init(void) { ++init_calls; return init_result; }
static void store_load_owner(int *p) { (void)p; ++after_store; }
static void vTaskDelay(int ticks) { if (ticks != portMAX_DELAY) abort(); ++delays; longjmp(stopped, 1); }
'''
suffix = r'''
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "line %d: %s\\n", __LINE__, #c); return 1; } } while (0)
int main(void) {
    for (int error = 1; error <= 2; ++error) {
        init_result = error;
        if (!setjmp(stopped)) { app_main(); return 1; }
        CHECK(delays == error && init_calls == error && board_calls == error && after_store == 0);
    }
    init_result = ESP_OK; app_main();
    CHECK(init_calls == 3 && board_calls == 3 && after_store == 1);
    puts("PASS NVS failure halts before owner load");
    return 0;
}
'''
# Exercise the real startup prefix through the first owner read; later boot code
# depends on peripherals unrelated to the NVS fail-closed boundary.
startup = source[source.index('void app_main(void)'):source.index('    store_load_lost(&lost);')]
startup += "}\n"
with tempfile.TemporaryDirectory(prefix='aelys-boot-test-') as directory:
    test_source = pathlib.Path(directory) / 'boot_test.c'
    executable = pathlib.Path(directory) / 'boot_test'
    test_source.write_text(prefix + function('static void halt(') + '\n' + startup + '\n' + suffix)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', str(test_source), '-o', str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
