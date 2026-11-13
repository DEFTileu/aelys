#include "beep.h"

#define TABLE_N 32
/* round(24000 * sin(2 pi k / 32)): about 73 % of full scale */
static const int16_t sine[TABLE_N] = {
    0, 4682, 9184, 13334, 16971, 19955, 22173, 23539, 24000, 23539, 22173, 19955, 16971, 13334, 9184, 4682,
    0, -4682, -9184, -13334, -16971, -19955, -22173, -23539, -24000, -23539, -22173, -19955, -16971, -13334, -9184, -4682,
};
#define STEP_Q16 ((uint32_t)((uint64_t)BEEP_FREQ_HZ * TABLE_N * 65536 / BEEP_RATE_HZ)) /* table entries per frame, Q16 */

beep_phase_t beep_phase(uint32_t elapsed_ms, uint32_t total_ms)
{
    if (total_ms > BEEP_MAX_MS) total_ms = BEEP_MAX_MS;
    if (elapsed_ms >= total_ms) return BEEP_DONE;
    return elapsed_ms % (BEEP_ON_MS + BEEP_OFF_MS) < BEEP_ON_MS ? BEEP_ON : BEEP_OFF;
}

void beep_fill(int16_t *out, size_t frames, uint32_t *phase, bool on)
{
    if (!on) {
        for (size_t i = 0; i < 2 * frames; i++) out[i] = 0;
        *phase = 0;
        return;
    }
    uint32_t p = *phase;
    for (size_t i = 0; i < frames; i++) {
        out[2 * i] = out[2 * i + 1] = sine[(p >> 16) & (TABLE_N - 1)];
        p += STEP_Q16;
    }
    *phase = p;
}
