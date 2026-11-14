/* Host-only short PCM cues. No platform audio API or firmware dependency. */
#include "sim_cues.h"
#include <math.h>

#define TAU 6.2831853071795864769
#define AMP 2200.0

typedef struct { unsigned ms; double first, last; unsigned segments; } cue_spec_t;
static const cue_spec_t SPECS[] = {
    [CUE_JOY] = {220, 660, 880, 2},
    [CUE_ELATION] = {360, 523, 1046, 3},
    [CUE_SURPRISE] = {180, 500, 950, 1},
    [CUE_FRIGHT] = {100, 1150, 1150, 1},
    [CUE_TENDER] = {320, 280, 360, 1},
};

size_t sim_cue_render(character_cue_t cue, int16_t *samples, size_t capacity)
{
    if (!samples || cue < CUE_JOY || cue > CUE_TENDER) return 0;
    const cue_spec_t *spec = &SPECS[cue];
    size_t count = SIM_CUE_RATE * spec->ms / 1000u;
    if (capacity < count) return 0;
    double phase = 0;
    for (size_t i = 0; i < count; i++) {
        double time = (double)i / (double)(count - 1);
        double progress = time;
        if (spec->segments > 1) {
            unsigned part = (unsigned)(time * spec->segments);
            if (part >= spec->segments) part = spec->segments - 1;
            progress = (double)part / (spec->segments - 1);
        }
        double freq = spec->first + (spec->last - spec->first) * progress;
        double fade = (double)i / 128.0;
        double end = (double)(count - 1 - i) / 128.0;
        if (fade > 1) fade = 1;
        if (end < fade) fade = end;
        samples[i] = (int16_t)(sin(phase) * AMP * fade);
        phase += TAU * freq / SIM_CUE_RATE;
    }
    return count;
}

static int bytes(FILE *f, const unsigned char *data, size_t n)
{ return fwrite(data, 1, n, f) == n ? 0 : -1; }
static int le16(FILE *f, uint16_t v)
{ unsigned char b[2] = {(unsigned char)v, (unsigned char)(v >> 8)}; return bytes(f, b, sizeof b); }
static int le32(FILE *f, uint32_t v)
{ unsigned char b[4] = {(unsigned char)v, (unsigned char)(v >> 8), (unsigned char)(v >> 16), (unsigned char)(v >> 24)}; return bytes(f, b, sizeof b); }

int sim_cue_write_wav(FILE *file, character_cue_t cue)
{
    if (!file) return -1;
    int16_t samples[SIM_CUE_MAX_SAMPLES];
    size_t count = sim_cue_render(cue, samples, SIM_CUE_MAX_SAMPLES);
    if (!count) return -1;
    uint32_t size = (uint32_t)count * 2u;
    if (bytes(file, (const unsigned char *)"RIFF", 4) || le32(file, 36u + size) ||
        bytes(file, (const unsigned char *)"WAVEfmt ", 8) || le32(file, 16) || le16(file, 1) ||
        le16(file, 1) || le32(file, SIM_CUE_RATE) || le32(file, SIM_CUE_RATE * 2u) ||
        le16(file, 2) || le16(file, 16) || bytes(file, (const unsigned char *)"data", 4) || le32(file, size)) return -1;
    for (size_t i = 0; i < count; i++) if (le16(file, (uint16_t)samples[i])) return -1;
    return 0;
}
