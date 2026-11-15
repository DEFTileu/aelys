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

#define GROWL_FRAMES (BEEP_RATE_HZ / 1000 * GROWL_MS)
#define GROWL_PEAK 16000
#define GROWL_ATTACK (BEEP_RATE_HZ / 1000 * 40)
#define GROWL_RELEASE (BEEP_RATE_HZ / 1000 * 120)
#define STEP_A_Q16 ((uint32_t)((uint64_t)GROWL_HZ_A * TABLE_N * 65536 / BEEP_RATE_HZ))
#define STEP_B_Q16 ((uint32_t)((uint64_t)GROWL_HZ_B * TABLE_N * 65536 / BEEP_RATE_HZ))

/* the table with linear interpolation: at 175 Hz it is a third of an entry per frame, steps would buzz harshly */
static int32_t tone(uint32_t p)
{
    int32_t a = sine[(p >> 16) & (TABLE_N - 1)], b = sine[((p >> 16) + 1) & (TABLE_N - 1)];
    return a + (b - a) * (int32_t)((p >> 8) & 255) / 256;
}

void growl_fill(int16_t *out, size_t frames, uint32_t start_frame)
{
    for (size_t i = 0; i < frames; i++) {
        uint32_t n = start_frame + (uint32_t)i;
        int32_t v = 0;
        if (n < GROWL_FRAMES) {
            int32_t s = tone(n * STEP_A_Q16) + tone(n * STEP_B_Q16);
            s = s > GROWL_PEAK ? GROWL_PEAK : s < -GROWL_PEAK ? -GROWL_PEAK : s;
            uint32_t ph = n * GROWL_AM_HZ % BEEP_RATE_HZ; /* triangle tremolo: 30 % .. 100 % of the level */
            int32_t am = 300 + 700 * (int32_t)(ph < BEEP_RATE_HZ / 2 ? ph : BEEP_RATE_HZ - ph) / (BEEP_RATE_HZ / 2);
            int32_t edge = n < GROWL_ATTACK ? (int32_t)n * 1000 / GROWL_ATTACK
                         : n >= GROWL_FRAMES - GROWL_RELEASE ? (int32_t)(GROWL_FRAMES - n) * 1000 / GROWL_RELEASE : 1000;
            v = s * am / 1000 * edge / 1000;
        }
        out[2 * i] = out[2 * i + 1] = (int16_t)v;
    }
}
