#pragma once
/* Lock-free triple buffer for one writer task and one reader task (C11 atomics). The writer fills
 * tribuf_back() and calls tribuf_publish(); the reader calls tribuf_latest(). Neither ever waits, and
 * a slot is never written while the other side reads it. Pure C, no IDF. */
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>

/* mid: bits 0-1 = index of the middle slot, bit 7 = it holds a publish the reader has not taken yet.
 * back is owned by the writer, front by the reader. */
typedef struct { _Atomic uint8_t mid; uint8_t back, front; void *slot[3]; } tribuf_t;

/* The three slots must be distinct, equal-sized buffers. The reader sees slot s2 (not fresh) until the first publish. */
void tribuf_init(tribuf_t *t, void *s0, void *s1, void *s2);
/* Writer only: the slot to fill next. Its old contents are stale (an earlier publish), not zeroed. */
void *tribuf_back(tribuf_t *t);
/* Writer only: make the back slot the newest one. */
void tribuf_publish(tribuf_t *t);
/* Reader only: the newest published slot; *fresh (may be NULL) tells whether it changed since the last call.
 * The pointer stays valid and unchanged until the next call. */
const void *tribuf_latest(tribuf_t *t, bool *fresh);
