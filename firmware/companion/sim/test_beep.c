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

/* ---- the growl: 600 ms, 175 + 190 Hz clipped to a square-ish buzz, 28 Hz tremolo, quieter than Find ---- */
#define GROWL_FRAMES_N (BEEP_RATE_HZ / 1000 * GROWL_MS)

static int16_t g_growl[2 * GROWL_FRAMES_N + 2 * BEEP_CHUNK_FRAMES];

static void render_growl(void) /* the audio task's way: 10 ms chunks, 20 of silence after the end */
{
    for (uint32_t c = 0; c * BEEP_CHUNK_FRAMES < GROWL_FRAMES_N + 2 * BEEP_CHUNK_FRAMES; c++)
        growl_fill(g_growl + 2 * c * BEEP_CHUNK_FRAMES, BEEP_CHUNK_FRAMES, c * BEEP_CHUNK_FRAMES);
}

static int gabs(int n) { return g_growl[2 * n] < 0 ? -g_growl[2 * n] : g_growl[2 * n]; }

static void test_growl_is_600ms_and_quieter_than_find(void)
{
    CHECK_EQ(GROWL_MS, 600);
    CHECK(GROWL_VOLUME > 0 && GROWL_VOLUME <= BEEP_VOLUME - 25);   /* codec volume: clearly below Find's */
    render_growl();
    int peak = 0;
    for (int i = 0; i < GROWL_FRAMES_N + 2 * BEEP_CHUNK_FRAMES; i++) {
        CHECK_EQ(g_growl[2 * i], g_growl[2 * i + 1]);               /* both channels the same */
        if (gabs(i) > peak) peak = gabs(i);
    }
    CHECK(peak > 8000 && peak <= 16000);                            /* and the signal itself stays below Find's 24000 */
    for (int i = GROWL_FRAMES_N; i < GROWL_FRAMES_N + 2 * BEEP_CHUNK_FRAMES; i++) CHECK_EQ(g_growl[2 * i], 0); /* ends at once */
    CHECK(gabs(0) < 100);                                           /* fades in and out: no click */
    for (int i = 0; i < 50; i++) CHECK(gabs(GROWL_FRAMES_N - 1 - i) < 600);
    int quiet = 0;
    for (int i = 0; i < 80; i++) quiet += gabs(i);
    CHECK(quiet / 80 < 1500);                                       /* the first 5 ms is the start of the attack */
}

static void test_growl_is_low_and_rough(void)
{
    CHECK(GROWL_HZ_A >= 160 && GROWL_HZ_A <= 220 && GROWL_HZ_B >= 160 && GROWL_HZ_B <= 220 && GROWL_HZ_A != GROWL_HZ_B);
    CHECK(GROWL_AM_HZ >= 25 && GROWL_AM_HZ <= 30);
    render_growl();
    int up = 0;                                                     /* upward zero crossings in 100 .. 500 ms */
    for (int i = 1600; i < 8000; i++)
        if (g_growl[2 * (i - 1)] <= 0 && g_growl[2 * i] > 0) up++;
    int hz = up * 1000 / 400;
    CHECK(hz >= 160 && hz <= 220);                                  /* the pitch of a low growl */

    /* the tremolo: around the trough of the 28 Hz modulation (frame 0 of each cycle) the buzz is much weaker than at its crest */
    int cycle = BEEP_RATE_HZ / GROWL_AM_HZ, weak = 0, strong = 0;
    for (int k = 4; k < 12; k++) {
        int trough = 0, crest = 0;
        for (int d = -96; d <= 96; d++) {
            int a = gabs(k * cycle + d), b = gabs(k * cycle + cycle / 2 + d);
            if (a > trough) trough = a;
            if (b > crest) crest = b;
        }
        weak += trough; strong += crest;
    }
    CHECK(weak * 4 < strong * 3);                                   /* at least a quarter quieter at the troughs */
}

static void test_growl_chunks_equal_one_pass(void)
{
    static int16_t whole[2 * 1000], a[2 * 400], b[2 * 600];
    growl_fill(whole, 1000, 5000);
    growl_fill(a, 400, 5000);
    growl_fill(b, 600, 5400);
    CHECK(!memcmp(a, whole, sizeof a));
    CHECK(!memcmp(b, whole + 800, sizeof b));
    growl_fill(whole, 10, GROWL_FRAMES_N + 12345);                  /* past the end: silence */
    for (int i = 0; i < 20; i++) CHECK_EQ(whole[i], 0);
}

int main(void)
{
    test_pattern_200_on_200_off();
    test_60_second_cap();
    test_chunk_walk();
    test_tone_is_2khz_stereo_sine();
    test_phase_carries_between_calls();
    test_silence_resets_the_phase();
    test_growl_is_600ms_and_quieter_than_find();
    test_growl_is_low_and_rough();
    test_growl_chunks_equal_one_pass();
    return g_failed ? 1 : 0;
}
