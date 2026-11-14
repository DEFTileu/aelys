"""Exercise the production probe's posting behavior with a fake clock."""
from pathlib import Path
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / 'components/board/board_input.c').read_text()
start = source.index('static void probe_swipe(void)')
opening = source.index('{', start)
depth = 1
for i in range(opening + 1, len(source)):
    if source[i] == '{':
        depth += 1
    elif source[i] == '}':
        depth -= 1
        if depth == 0:
            function = source[start:i + 1]
            break
else:
    raise ValueError('unclosed probe_swipe')

prefix = r'''
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
typedef struct { unsigned type, len; unsigned char data[8]; } ui_event_t;
#define BOARD_UI_EV_PERF 123
static int64_t now_us;
static int posts;
static int64_t esp_timer_get_time(void) { return now_us; }
static bool lv_port_post(const ui_event_t *ev) {
    if (ev->type != BOARD_UI_EV_PERF || ev->len != sizeof(uint32_t)) return false;
    ++posts; return true;
}
'''
suffix = r'''
int main(void) {
    now_us=2500000; probe_swipe(); now_us=3500000; probe_swipe();
    now_us=4600000; probe_swipe();
#ifdef CONFIG_AELYS_PROBE_AUTO_SWIPE
    return posts == 2 ? 0 : 1;
#else
    return posts == 0 ? 0 : 2;
#endif
}
'''
with tempfile.TemporaryDirectory(prefix='aelys-probe-swipe-') as directory:
    c = Path(directory) / 'test.c'
    exe = Path(directory) / 'test'
    c.write_text(prefix + function + suffix)
    for enabled in (False, True):
        args = ['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Wno-unused-variable']
        if enabled:
            args.append('-DCONFIG_AELYS_PROBE_AUTO_SWIPE=1')
        subprocess.run(args + [str(c), '-o', str(exe)], check=True)
        subprocess.run([str(exe)], check=True)
print('PASS: passive probe posts no swipes; enabled probe posts at the expected cadence')
