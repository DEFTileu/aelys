#include <string.h>
#include "beep.h"
#include "check.h"

static void test_pattern_200_on_200_off(void)
{
    CHECK_EQ(beep_phase(0, 60000), BEEP_ON);
    CHECK_EQ(beep_phase(199, 60000), BEEP_ON);
    CHECK_EQ(beep_phase(200, 60000), BEEP_OFF);
    CHECK_EQ(beep_phase(399, 60000), BEEP_OFF);
    CHECK_EQ(beep_phase(400, 60000), BEEP_ON);
    CHECK_EQ(beep_phase(59600, 60000), BEEP_ON);
    CHECK_EQ(beep_phase(59799, 60000), BEEP_ON);
    CHECK_EQ(beep_phase(59800, 60000), BEEP_OFF);
}

static void test_60_second_cap(void)
{
    CHECK_EQ(beep_phase(59999, 60000), BEEP_OFF);
    CHECK_EQ(beep_phase(60000, 60000), BEEP_DONE);
    CHECK_EQ(beep_phase(60000, 90000), BEEP_DONE); /* a longer request is cut at 60 s */
    CHECK_EQ(beep_phase(59990, 90000), BEEP_OFF);
    CHECK_EQ(beep_phase(1000, 1000), BEEP_DONE);   /* a shorter one ends when asked */
    CHECK_EQ(beep_phase(0, 0), BEEP_DONE);
}

/* The playback loop's view: how many 10 ms chunks sound over a full minute. */
static void test_chunk_walk(void)
{
    int on = 0, off = 0, n = 0;
    while (beep_phase((uint32_t)n * BEEP_CHUNK_MS, 60000) != BEEP_DONE) {
        if (beep_phase((uint32_t)n * BEEP_CHUNK_MS, 60000) == BEEP_ON) on++; else off++;
        n++;
    }
    CHECK_EQ(n, 6000);
    CHECK_EQ(on, 3000);
    CHECK_EQ(off, 3000);
}

static void test_tone_is_2khz_stereo_sine(void)
{
    int16_t buf[2 * BEEP_CHUNK_FRAMES];
    uint32_t phase = 0;
    beep_fill(buf, BEEP_CHUNK_FRAMES, &phase, true);
    CHECK_EQ(buf[0], 0);                                    /* starts at zero: no click */
    int cross = 0, peak = 0;
    for (int i = 0; i < BEEP_CHUNK_FRAMES; i++) {
        CHECK_EQ(buf[2 * i], buf[2 * i + 1]);               /* both channels the same */
        if (i && buf[2 * (i - 1)] <= 0 && buf[2 * i] > 0) cross++;
        int a = buf[2 * i] < 0 ? -buf[2 * i] : buf[2 * i];
        if (a > peak) peak = a;
    }
    CHECK_EQ(cross, 20);                                    /* 20 periods in 10 ms = 2 kHz */
    CHECK_EQ(peak, 24000);
    CHECK_EQ(phase & 0x1FFFFFu, 0);                         /* whole periods: the next chunk starts at 0 again */
    CHECK_EQ(buf[2 * 1], 16971 /* table[4] */);             /* 8 frames per period: 45 degrees per frame */
    CHECK_EQ(buf[2 * 2], 24000);
    CHECK_EQ(buf[2 * 4], 0);
    CHECK_EQ(buf[2 * 6], -24000);
}

static void test_phase_carries_between_calls(void)
{
    int16_t a[2 * 3], whole[2 * 6];
    uint32_t p = 0, q = 0;
    beep_fill(a, 3, &p, true);
    int16_t b[2 * 3];
    beep_fill(b, 3, &p, true);
    beep_fill(whole, 6, &q, true);
    CHECK(!memcmp(a, whole, sizeof a));
    CHECK(!memcmp(b, whole + 6, sizeof b));
}

static void test_silence_resets_the_phase(void)
{
    int16_t buf[2 * 5];
    uint32_t phase = 0;
    beep_fill(buf, 3, &phase, true);
    CHECK(phase != 0);
    beep_fill(buf, 5, &phase, false);
    for (int i = 0; i < 10; i++) CHECK_EQ(buf[i], 0);
    CHECK_EQ(phase, 0);
    beep_fill(buf, 2, &phase, true);
    CHECK_EQ(buf[0], 0);                                    /* the next tone starts at zero */
}

int main(void)
{
    test_pattern_200_on_200_off();
    test_60_second_cap();
    test_chunk_walk();
    test_tone_is_2khz_stereo_sine();
    test_phase_carries_between_calls();
    test_silence_resets_the_phase();
    return g_failed ? 1 : 0;
}
