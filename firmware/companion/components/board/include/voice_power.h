#pragma once
/* Pure watchdog policy. Only the input task owns this state; UI requests are pulses.
 * A recording's automatic end must not restore shutdown while PWR is still down. */
#include <stdbool.h>
#include <stdint.h>
#define VOICE_POWER_MAX_MS 25000u
typedef struct { bool held; uint32_t since_ms; } voice_power_t;
static inline bool voice_power_update(voice_power_t *p, bool start, bool top, uint32_t now_ms)
{
    if (start && !p->held && top) { p->held = true; p->since_ms = now_ms; }
    if (!top || (p->held && (uint32_t)(now_ms - p->since_ms) >= VOICE_POWER_MAX_MS)) p->held = false;
    return p->held;
}
static inline void voice_power_cancel(voice_power_t *p) { p->held = false; }
