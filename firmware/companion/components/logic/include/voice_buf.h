#pragma once
/* When the board plays a streamed spoken reply. It waits for VOICE_PREBUFFER_BYTES (or the end of the reply) before it starts, and when
 * the ring runs dry mid-reply it waits again: network jitter then makes one short pause instead of a crackle of tiny gaps, which the
 * 40 ms of I2S DMA alone cannot hide. Pure C. */
#include <stdbool.h>
#include <stddef.h>

#define VOICE_PREBUFFER_BYTES (16000 * 2 * 3 / 10) /* 300 ms of 16 kHz 16-bit mono */

/* The new playing state from the old one, the bytes waiting in the ring and whether the reply has ended. */
static inline bool voice_buf_playing(bool playing, size_t used, bool end)
{
    if (!playing) return used >= VOICE_PREBUFFER_BYTES || (end && used);
    return used || end;
}
