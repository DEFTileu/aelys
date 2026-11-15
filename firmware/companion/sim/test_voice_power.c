#include <assert.h>
#include <stdint.h>
#include "voice_power.h"
int main(void) {
 voice_power_t p = {0};
 assert(!voice_power_update(&p, false, true, 100));
 assert(voice_power_update(&p, true, true, 100));
 assert(voice_power_update(&p, false, true, 20500)); /* auto-END stays held */
 assert(!voice_power_update(&p, false, false, 20600));
 assert(voice_power_update(&p, true, true, 30000));
 assert(!voice_power_update(&p, false, true, 55000));
 assert(!voice_power_update(&p, false, true, 55001));
 assert(!voice_power_update(&p, false, false, 55002));
 assert(voice_power_update(&p, true, true, UINT32_MAX - 100));
 assert(!voice_power_update(&p, false, true, 24899));
 voice_power_cancel(&p);
 assert(!p.held);
 assert(!voice_power_update(&p, false, true, 24900));
}
