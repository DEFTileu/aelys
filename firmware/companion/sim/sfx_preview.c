/* Writes every sound effect as <dir>/<name>.wav (16 kHz mono) to listen to on the Mac: sfx_preview <dir> */
#include <stdio.h>
#include "beep.h"
#include "sfx.h"

static void put32(FILE *f, unsigned v) { for (int i = 0; i < 4; i++) fputc((v >> (8 * i)) & 0xFF, f); }
static void put16(FILE *f, unsigned v) { fputc(v & 0xFF, f); fputc((v >> 8) & 0xFF, f); }

int main(int argc, char **argv)
{
    if (argc != 2) { fprintf(stderr, "usage: %s <dir>\n", argv[0]); return 2; }
    for (int id = SFX_NONE + 1; id < SFX_COUNT; id++) {
        char path[512];
        snprintf(path, sizeof path, "%s/%02d_%s.wav", argv[1], id, sfx_name((sfx_t)id));
        FILE *f = fopen(path, "wb");
        if (!f) { perror(path); return 1; }
        static int16_t pcm[2 * BEEP_CHUNK_FRAMES * 500];
        sfx_player_t p;
        sfx_start(&p, (sfx_t)id);
        unsigned n = 0;
        while (n < 500 && sfx_fill(&p, pcm + 2 * BEEP_CHUNK_FRAMES * n, BEEP_CHUNK_FRAMES)) n++;
        unsigned frames = n * BEEP_CHUNK_FRAMES, bytes = frames * 2;
        fwrite("RIFF", 1, 4, f); put32(f, 36 + bytes); fwrite("WAVEfmt ", 1, 8, f);
        put32(f, 16); put16(f, 1); put16(f, 1); put32(f, BEEP_RATE_HZ); put32(f, BEEP_RATE_HZ * 2); put16(f, 2); put16(f, 16);
        fwrite("data", 1, 4, f); put32(f, bytes);
        for (unsigned i = 0; i < frames; i++) put16(f, (unsigned)(uint16_t)pcm[2 * i]);
        fclose(f);
    }
    return 0;
}
