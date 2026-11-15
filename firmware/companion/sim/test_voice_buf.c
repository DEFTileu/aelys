#include "check.h"
#include "voice_buf.h"

int main(void)
{
    CHECK(!voice_buf_playing(false, 0, false));
    CHECK(!voice_buf_playing(false, VOICE_PREBUFFER_BYTES - 2, false)); /* not enough yet */
    CHECK(voice_buf_playing(false, VOICE_PREBUFFER_BYTES, false));
    CHECK(voice_buf_playing(true, 2, false));                            /* playing keeps playing while anything waits */
    CHECK(!voice_buf_playing(true, 0, false));                           /* ran dry mid-reply: buffer again */
    CHECK(voice_buf_playing(false, 100, true));                          /* a short reply plays at once once it has ended */
    CHECK(!voice_buf_playing(false, 0, true));                           /* nothing left: the worker sees the end */
    return g_failed ? 1 : 0;
}
