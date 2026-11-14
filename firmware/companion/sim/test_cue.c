#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "check.h"
#include "sim_cues.h"

static unsigned le32(const unsigned char *p)
{ return (unsigned)p[0] | (unsigned)p[1] << 8 | (unsigned)p[2] << 16 | (unsigned)p[3] << 24; }

static void test_cue_samples(void)
{
    int16_t samples[SIM_CUE_MAX_SAMPLES], second[SIM_CUE_MAX_SAMPLES];
    for (int cue = CUE_JOY; cue <= CUE_TENDER; cue++) {
        size_t n = sim_cue_render((character_cue_t)cue, samples, SIM_CUE_MAX_SAMPLES);
        CHECK(n > 0 && n <= SIM_CUE_RATE / 2);
        if (!n || n > SIM_CUE_MAX_SAMPLES) continue;
        CHECK_EQ(samples[0], 0); CHECK_EQ(samples[n - 1], 0);
        int peak = 0, nonzero = 0;
        for (size_t i = 0; i < n; i++) {
            int a = samples[i] < 0 ? -samples[i] : samples[i];
            if (a > peak) peak = a;
            nonzero += a != 0;
        }
        CHECK(peak > 100 && peak <= 3277); CHECK(nonzero > 100);
        CHECK_EQ(sim_cue_render((character_cue_t)cue, second, SIM_CUE_MAX_SAMPLES), n);
        CHECK(!memcmp(samples, second, n * sizeof *samples));
        CHECK_EQ(sim_cue_render((character_cue_t)cue, second, n - 1), 0);
    }
    CHECK_EQ(sim_cue_render(CUE_NONE, samples, SIM_CUE_MAX_SAMPLES), 0);
    CHECK_EQ(sim_cue_render((character_cue_t)99, samples, SIM_CUE_MAX_SAMPLES), 0);
    CHECK_EQ(sim_cue_render(CUE_JOY, NULL, SIM_CUE_MAX_SAMPLES), 0);
}

static void test_wav(void)
{
    for (int cue = CUE_JOY; cue <= CUE_TENDER; cue++) {
        FILE *f = tmpfile(); CHECK(f != NULL); if (!f) continue;
        int written = sim_cue_write_wav(f, (character_cue_t)cue);
        CHECK_EQ(written, 0);
        if (written) { fclose(f); continue; }
        long length = ftell(f); rewind(f);
        unsigned char header[44]; CHECK_EQ(fread(header, 1, sizeof header, f), sizeof header);
        CHECK(!memcmp(header, "RIFF", 4) && !memcmp(header + 8, "WAVEfmt ", 8));
        CHECK(!memcmp(header + 36, "data", 4));
        CHECK_EQ(le32(header + 4), length - 8); CHECK_EQ(le32(header + 24), SIM_CUE_RATE);
        CHECK_EQ(le32(header + 40), length - 44); CHECK(length <= 44 + (long)SIM_CUE_RATE);
        fclose(f);
    }
    CHECK(sim_cue_write_wav(NULL, CUE_JOY) != 0);
    FILE *f = tmpfile(); CHECK(f != NULL);
    if (f) { CHECK(sim_cue_write_wav(f, CUE_NONE) != 0); CHECK_EQ(ftell(f), 0); fclose(f); }
}
int main(void) { test_cue_samples(); test_wav(); return g_failed ? 1 : 0; }
