/* Sound effects: every one plays, stays in range, starts and ends without a click, and stops. */
#include <stdlib.h>
#include "beep.h"
#include "check.h"
#include "sfx.h"

int main(void)
{
    CHECK_EQ(sfx_length_ms(SFX_NONE), 0u);
    CHECK_EQ(sfx_length_ms(SFX_COUNT), 0u);
    sfx_player_t p;
    int16_t buf[2 * BEEP_CHUNK_FRAMES];
    sfx_start(&p, SFX_NONE);
    CHECK(!sfx_fill(&p, buf, BEEP_CHUNK_FRAMES));            /* nothing to play */
    for (int id = SFX_NONE + 1; id < SFX_COUNT; id++) {
        uint32_t ms = sfx_length_ms((sfx_t)id);
        CHECK(ms >= 30 && ms <= 4000);                        /* short; the timer's bells are the longest */
        sfx_start(&p, (sfx_t)id);
        int chunks = 0, peak = 0, first = -1, last = 0;
        while (sfx_fill(&p, buf, BEEP_CHUNK_FRAMES)) {
            for (int i = 0; i < BEEP_CHUNK_FRAMES; i++) {
                int v = buf[2 * i];
                CHECK_EQ(buf[2 * i + 1], buf[2 * i]);           /* both channels */
                if (first < 0) first = abs(v);
                if (abs(v) > peak) peak = abs(v);
                last = abs(v);
            }
            CHECK(++chunks <= 410);                            /* it ends */
        }
        CHECK_EQ(chunks, (int)((ms + BEEP_CHUNK_MS - 1) / BEEP_CHUNK_MS));
        CHECK(peak > 3000 && peak < 32000);                    /* audible, never clipped */
        CHECK(first < 2000 && last < 2000);                    /* no click at either end */
        CHECK(!sfx_fill(&p, buf, BEEP_CHUNK_FRAMES));
        for (int i = 0; i < 2 * BEEP_CHUNK_FRAMES; i++) CHECK_EQ(buf[i], 0);
        CHECK(sfx_name((sfx_t)id)[0] != 0);
    }
    return g_failed ? 1 : 0;
}
