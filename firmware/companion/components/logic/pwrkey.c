#include <string.h>
#include "pwrkey.h"

void pwrkey_reset(pwrkey_t *k) { memset(k, 0, sizeof *k); }

bool pwrkey_update(pwrkey_t *k, bool neg, bool pos, uint32_t now_ms)
{
    if (pos) {
        k->down = false;
    } else if (neg) {
        k->down = true;
        k->since_ms = now_ms;
    } else if (k->down && now_ms - k->since_ms > PWRKEY_STALE_MS) {
        k->down = false;
    }
    return k->down;
}
