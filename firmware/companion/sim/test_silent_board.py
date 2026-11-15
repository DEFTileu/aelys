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

# The growl is gated the same way: no lock, no task, no platform call while board sound is disabled.
start = source.index('void board_audio_growl(')
opening = source.index('{', start)
depth = 1
for i in range(opening + 1, len(source)):
    if source[i] == '{':
        depth += 1
    elif source[i] == '}':
        depth -= 1
        if depth == 0:
            growl_body = source[start:i + 1]
            break
else:
    raise ValueError('unclosed board_audio_growl')
growl_prefix = prefix.replace('static int lock_buf, lock, calls;', 'static int lock_buf, lock, calls;\nstatic void audio_lock_init(void) { ++calls; }\n#define pdTRUE 1\n#define GROWL_MS 600')
growl_suffix = r'''
int main(void) {
    board_audio_growl();
    return calls != 0;
}
'''
with tempfile.TemporaryDirectory(prefix='aelys-silent-growl-') as d:
    c = Path(d) / 'test.c'
    exe = Path(d) / 'test'
    c.write_text(growl_prefix + growl_body + growl_suffix)
    subprocess.run(['cc', '-std=c11', '-Wno-unused-function', '-Wno-unused-variable', str(c), '-o', str(exe)], check=True)
    subprocess.run([str(exe)], check=True)
print('PASS: silent board does not growl')

# Execute the real command case: a disabled feature must not be acknowledged
# as BUSY, because the server retries BUSY after every reconnection.
main_source = (Path(__file__).resolve().parents[1] / 'main/app_main.c').read_text()
case = main_source[main_source.index('    case CMD_PLAY_SOUND:'):main_source.index('    default:', main_source.index('    case CMD_PLAY_SOUND:'))]
command_prefix = r'''
#include <stdbool.h>
#include <string.h>
typedef int esp_err_t;
#define CMD_PLAY_SOUND 1
#define BEEP_MAX_MS 60000
#define ESP_OK 0
#define ESP_ERR_NOT_SUPPORTED 3
#define ESP_LOGW(...) ((void)0)
static const char *TAG = "fake";
static int result, acknowledged, success;
static const char *error;
static int board_audio_beep(int duration) { (void)duration; return result; }
static void link_send_ack(const char *id, bool ok, const char *err) { (void)id; ++acknowledged; success=ok; error=err; }
static void command(void) {
    const char *id = "test";
    switch (CMD_PLAY_SOUND) {
'''
command_suffix = r'''
    }
}
int main(void) {
    result=ESP_ERR_NOT_SUPPORTED; command();
    if (acknowledged != 1 || success || !error || strcmp(error, "UNSUPPORTED")) return 1;
    result=42; acknowledged=0; command();
    if (acknowledged != 1 || success || !error || strcmp(error, "BUSY")) return 2;
    result=ESP_OK; acknowledged=0; command();
    if (acknowledged != 1 || !success || error) return 3;
    return 0;
}
'''
with tempfile.TemporaryDirectory(prefix='aelys-silent-command-') as d:
    c = Path(d) / 'test.c'
    exe = Path(d) / 'test'
    c.write_text(command_prefix + case + command_suffix)
    subprocess.run(['cc', '-std=c11', '-Wno-unused-variable', str(c), '-o', str(exe)], check=True)
    subprocess.run([str(exe)], check=True)
print('PASS: disabled sound is not retried')
