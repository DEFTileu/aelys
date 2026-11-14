#pragma once
/* Short sound effects for the speaker: pure logic, no IDF. Each sound is a few notes (a pitch that may glide, a timbre, an envelope),
 * synthesised at the beep's 16 kHz stereo in 10 ms chunks (beep.h), so board_audio.c plays them through the same channel. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    SFX_NONE,
    SFX_TAP,      /* a tap on her face: a tiny chirp */
    SFX_OPEN,     /* an app opens from the menu */
    SFX_HUH,      /* picked up / touched after a long while: "oh?" */
    SFX_GIGGLE,   /* double tap: tickled */
    SFX_GRUMBLE,  /* poked four times: "hmph" */
    SFX_DIZZY,    /* shaken: a wobbling slide */
    SFX_EEK,      /* falling: a sharp slide down */
    SFX_SLEEP,    /* laid face down: a sinking sigh */
    SFX_WAKE,     /* turned back up: a rising yawn */
    SFX_DONE,     /* a task done: a quick arpeggio */
    SFX_ALL_DONE, /* the last task of the day: a fanfare */
    SFX_NOTIFY,   /* a new notice pops up */
    SFX_TIMER,    /* the timer ran out: bell dings */
    SFX_COIN,     /* the coin lands: a ting */
    SFX_DICE,     /* the dice roll: rattling clicks */
    SFX_GO,       /* reaction game: green */
    SFX_WIN,      /* a game won or a best time */
    SFX_COUNT
} sfx_t;

typedef struct {
    sfx_t id;
    uint8_t note;       /* index into the sound's notes */
    uint32_t at;        /* frames into that note */
    uint32_t phase;     /* oscillator phase, Q16 of the 256-entry table */
    uint32_t noise;     /* LFSR for the rattle */
} sfx_player_t;

void sfx_start(sfx_player_t *p, sfx_t id);
/* Fills `frames` stereo frames (L = R). Returns false once the sound is over (and fills silence); true while any of it is left. */
bool sfx_fill(sfx_player_t *p, int16_t *out, size_t frames);
uint32_t sfx_length_ms(sfx_t id); /* 0 for SFX_NONE and unknown ids */
const char *sfx_name(sfx_t id);   /* for logs and the previews */
