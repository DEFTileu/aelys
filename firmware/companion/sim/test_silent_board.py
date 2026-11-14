"""Execute the production audio entry point with host platform fakes."""
from pathlib import Path
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / 'components/board/board_audio.c').read_text()
start = source.index('esp_err_t board_audio_beep(')
opening = source.index('{', start)
depth = 1
for i in range(opening + 1, len(source)):
    if source[i] == '{':
        depth += 1
    elif source[i] == '}':
        depth -= 1
        if depth == 0:
            body = source[start:i + 1]
            break
else:
    raise ValueError('unclosed board_audio_beep')

prefix = r'''
#include <stdint.h>
#include <stdatomic.h>
#include <stddef.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_ARG 1
#define ESP_ERR_NO_MEM 2
#define ESP_ERR_NOT_SUPPORTED 3
#define CONFIG_AELYS_BOARD_SOUND_ENABLED 0
#define BEEP_MAX_MS 60000
#define AUDIO_TASK_STACK 1024
#define AUDIO_TASK_PRIO 1
#define portMAX_DELAY 0
#define pdPASS 1
static int lock_buf, lock, calls;
static void *task;
static atomic_int stop_req, want_ms, gen;
static int xSemaphoreCreateMutexStatic(int *p) { (void)p; ++calls; return 1; }
static void xSemaphoreTake(int x, int y) { (void)x; (void)y; ++calls; }
static void xSemaphoreGive(int x) { (void)x; ++calls; }
static void audio_task(void *p) { (void)p; }
static int xTaskCreate(void (*f)(void *), const char *n, int s, void *p, int pr, void **t) {
    (void)f; (void)n; (void)s; (void)p; (void)pr; (void)t; ++calls; return pdPASS;
}
static void post_find(int v) { (void)v; ++calls; }
#include <stdbool.h>
'''
suffix = r'''
int main(void) {
    if (board_audio_beep(1000) != ESP_ERR_NOT_SUPPORTED || calls != 0) return 1;
    if (board_audio_beep(60000) != ESP_ERR_NOT_SUPPORTED || calls != 0) return 2;
    return 0;
}
'''
with tempfile.TemporaryDirectory(prefix='aelys-silent-test-') as d:
    c = Path(d) / 'test.c'
    exe = Path(d) / 'test'
    c.write_text(prefix + body + suffix)
    subprocess.run(['cc', '-std=c11', '-Wno-unused-function', '-Wno-unused-variable', str(c), '-o', str(exe)], check=True)
    subprocess.run([str(exe)], check=True)
print('PASS: silent board rejects audio before platform calls')
