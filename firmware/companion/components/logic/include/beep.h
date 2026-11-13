#pragma once
/* The "find Aelys" tone: pure logic, no IDF. 2 kHz sine from a 32-entry table at 16 kHz stereo (8 frames per period),
 * 200 ms on / 200 ms off. The audio task (board_audio.c) plays it in 10 ms chunks: 160 frames = 20 whole periods, so a chunk
 * starts and ends at phase 0 and a gate edge never clicks. */
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#define BEEP_RATE_HZ 16000
#define BEEP_FREQ_HZ 2000
#define BEEP_CHUNK_MS 10
#define BEEP_CHUNK_FRAMES (BEEP_RATE_HZ * BEEP_CHUNK_MS / 1000)
#define BEEP_ON_MS 200
#define BEEP_OFF_MS 200
#define BEEP_MAX_MS 60000 /* design: "beeps and flashes for 1 minute" */

typedef enum { BEEP_OFF, BEEP_ON, BEEP_DONE } beep_phase_t;

/* What the speaker does `elapsed_ms` into a request of `total_ms` (capped at BEEP_MAX_MS): ON first, then OFF, repeating; DONE at the end. */
beep_phase_t beep_phase(uint32_t elapsed_ms, uint32_t total_ms);

/* Fills `frames` stereo frames (L = R, 2 x int16 each). `phase` is the table position (Q16), carried between calls; when !on the
 * chunk is silence and the phase is reset, so every tone starts at zero. */
void beep_fill(int16_t *out, size_t frames, uint32_t *phase, bool on);
