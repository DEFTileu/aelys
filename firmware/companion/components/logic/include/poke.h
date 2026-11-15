#pragma once
/* "Poked too often": 5 taps on the home screen within 3 s annoy Aelys (design: she gets annoyed when poked). Pure logic, no IDF.
 * After it fires, taps are ignored for 4 s (the annoyed face lasts 4 s), then it takes 5 fresh taps again. */
#include <stdbool.h>
#include <stdint.h>

#define POKE_TAPS 5
#define POKE_WINDOW_MS 3000   /* the 5th tap at most this long after the 1st */
#define POKE_COOLDOWN_MS 4000

typedef struct {
    uint32_t t[POKE_TAPS]; /* the last taps, oldest first */
    uint32_t fired_at;
    uint8_t n;
    bool fired;
} poke_t; /* zero-initialised = nobody poked her yet */

/* One tap at now_ms (wrapping milliseconds). True when this tap makes her annoyed. */
bool poke_feed(poke_t *p, uint32_t now_ms);
