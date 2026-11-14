#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include "character.h"

#define SIM_CUE_RATE 16000u
#define SIM_CUE_MAX_SAMPLES (SIM_CUE_RATE / 2u)
/* Returns sample count, or zero for an invalid cue / insufficient buffer. */
size_t sim_cue_render(character_cue_t cue, int16_t *samples, size_t capacity);
/* Write a mono 16-bit PCM WAV. Zero on success; never opens an audio device. */
int sim_cue_write_wav(FILE *file, character_cue_t cue);
