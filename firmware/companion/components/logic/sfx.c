#include "sfx.h"
#include "beep.h"
#include <math.h>

/* timbres */
enum { W_SINE, W_BELL, W_BUZZ, W_CLICK };
/* envelopes: PLUCK starts at once and fades to nothing, HOLD swells in and out over 8 ms at each end */
enum { E_PLUCK, E_HOLD };

typedef struct { uint16_t f0, f1, ms; uint8_t wave, env, vol; } note_t; /* f0 = f1 = 0: a rest; vol 0..100 */

#define N(f0, f1, ms, w, e, v) { f0, f1, ms, w, e, v }
#define REST(ms) { 0, 0, ms, W_SINE, E_HOLD, 0 }

/* Pitches (Hz): C6 1047, D6 1175, E6 1319, G6 1568, A6 1760, B6 1976, C7 2093, E7 2637, G7 3136 */
static const note_t tap[] = { N(1800, 2600, 35, W_SINE, E_PLUCK, 45) };
static const note_t open_[] = { N(1319, 1319, 45, W_BELL, E_PLUCK, 55), N(1760, 1760, 70, W_BELL, E_PLUCK, 55) };
static const note_t huh[] = { N(700, 1500, 110, W_SINE, E_HOLD, 60), REST(30), N(1500, 1900, 60, W_SINE, E_PLUCK, 50) };
static const note_t giggle[] = {
    N(1568, 1760, 45, W_SINE, E_PLUCK, 60), REST(25), N(1760, 1976, 45, W_SINE, E_PLUCK, 60), REST(25),
    N(1568, 1760, 45, W_SINE, E_PLUCK, 60), REST(25), N(1976, 2349, 45, W_SINE, E_PLUCK, 60), REST(25),
    N(2093, 2637, 70, W_SINE, E_PLUCK, 60),
};
static const note_t grumble[] = { N(330, 280, 140, W_BUZZ, E_HOLD, 55), REST(50), N(300, 220, 220, W_BUZZ, E_HOLD, 55) };
static const note_t dizzy[] = {
    N(1300, 700, 130, W_SINE, E_HOLD, 60), N(700, 1100, 130, W_SINE, E_HOLD, 60),
    N(1100, 600, 130, W_SINE, E_HOLD, 60), N(600, 900, 130, W_SINE, E_HOLD, 55), N(900, 450, 180, W_SINE, E_HOLD, 50),
};
static const note_t eek[] = { N(2600, 2900, 60, W_SINE, E_HOLD, 70), N(2900, 500, 260, W_SINE, E_HOLD, 70) };
static const note_t sleep_[] = { N(900, 650, 220, W_SINE, E_HOLD, 45), N(650, 380, 380, W_SINE, E_HOLD, 35) };
static const note_t wake[] = { N(420, 900, 300, W_SINE, E_HOLD, 45), N(900, 760, 160, W_SINE, E_HOLD, 45), REST(40), N(1568, 2093, 70, W_BELL, E_PLUCK, 50) };
static const note_t done[] = {
    N(1047, 1047, 70, W_BELL, E_PLUCK, 60), N(1319, 1319, 70, W_BELL, E_PLUCK, 60), N(1568, 1568, 70, W_BELL, E_PLUCK, 60),
    N(2093, 2093, 220, W_BELL, E_PLUCK, 65),
};
static const note_t all_done[] = {
    N(1047, 1047, 90, W_BELL, E_PLUCK, 60), N(1319, 1319, 90, W_BELL, E_PLUCK, 60), N(1568, 1568, 90, W_BELL, E_PLUCK, 60),
    N(2093, 2093, 160, W_BELL, E_PLUCK, 65), REST(40), N(1568, 1568, 90, W_BELL, E_PLUCK, 60), N(2093, 2093, 120, W_BELL, E_PLUCK, 65),
    N(2093, 3136, 320, W_SINE, E_PLUCK, 55),
};
static const note_t notify[] = { N(1976, 1976, 60, W_BELL, E_PLUCK, 55), REST(30), N(2637, 2637, 160, W_BELL, E_PLUCK, 55) };
static const note_t timer[] = {
    N(1976, 1976, 300, W_BELL, E_PLUCK, 70), REST(80), N(1976, 1976, 300, W_BELL, E_PLUCK, 70), REST(80),
    N(2637, 2637, 500, W_BELL, E_PLUCK, 70), REST(300),
    N(1976, 1976, 300, W_BELL, E_PLUCK, 70), REST(80), N(1976, 1976, 300, W_BELL, E_PLUCK, 70), REST(80),
    N(2637, 2637, 600, W_BELL, E_PLUCK, 70),
};
static const note_t coin[] = { N(2637, 2637, 60, W_BELL, E_PLUCK, 60), N(3136, 3136, 380, W_BELL, E_PLUCK, 60) };
static const note_t dice[] = {
    N(0, 0, 25, W_CLICK, E_PLUCK, 60), REST(60), N(0, 0, 25, W_CLICK, E_PLUCK, 55), REST(90), N(0, 0, 25, W_CLICK, E_PLUCK, 60),
    REST(50), N(0, 0, 25, W_CLICK, E_PLUCK, 50), REST(130), N(0, 0, 25, W_CLICK, E_PLUCK, 55), REST(170), N(0, 0, 30, W_CLICK, E_PLUCK, 60),
};
static const note_t go[] = { N(2093, 2093, 120, W_BELL, E_PLUCK, 70) };
static const note_t win[] = {
    N(1568, 1568, 80, W_BELL, E_PLUCK, 60), N(2093, 2093, 80, W_BELL, E_PLUCK, 60), N(2637, 2637, 80, W_BELL, E_PLUCK, 60),
    N(3136, 3136, 260, W_BELL, E_PLUCK, 65),
};

typedef struct { const note_t *n; uint8_t count; const char *name; } sound_t;
#define S(a, nm) { a, sizeof a / sizeof *a, nm }
static const sound_t sounds[SFX_COUNT] = {
    [SFX_TAP] = S(tap, "tap"), [SFX_OPEN] = S(open_, "open"), [SFX_HUH] = S(huh, "huh"), [SFX_GIGGLE] = S(giggle, "giggle"),
    [SFX_GRUMBLE] = S(grumble, "grumble"), [SFX_DIZZY] = S(dizzy, "dizzy"), [SFX_EEK] = S(eek, "eek"), [SFX_SLEEP] = S(sleep_, "sleep"),
    [SFX_WAKE] = S(wake, "wake"), [SFX_DONE] = S(done, "done"), [SFX_ALL_DONE] = S(all_done, "all_done"),
    [SFX_NOTIFY] = S(notify, "notify"), [SFX_TIMER] = S(timer, "timer"), [SFX_COIN] = S(coin, "coin"), [SFX_DICE] = S(dice, "dice"),
    [SFX_GO] = S(go, "go"), [SFX_WIN] = S(win, "win"),
};

#define TABLE 256
#define AMP 20000 /* about 61 % of full scale at vol 100, so a bell's added octave cannot clip */
#define EDGE_FRAMES (BEEP_RATE_HZ * 8 / 1000)
static int16_t sine[TABLE];

static const sound_t *sound(sfx_t id) { return id > SFX_NONE && id < SFX_COUNT ? &sounds[id] : NULL; }

const char *sfx_name(sfx_t id) { const sound_t *s = sound(id); return s ? s->name : "none"; }

uint32_t sfx_length_ms(sfx_t id)
{
    const sound_t *s = sound(id);
    uint32_t ms = 0;
    for (int i = 0; s && i < s->count; i++) ms += s->n[i].ms;
    return ms;
}

void sfx_start(sfx_player_t *p, sfx_t id)
{
    if (!sine[TABLE / 4])
        for (int i = 0; i < TABLE; i++) sine[i] = (int16_t)lrintf(32767.0f * sinf(6.2831853f * (float)i / TABLE));
    *p = (sfx_player_t){ .id = sound(id) ? id : SFX_NONE, .noise = 0xACE1u };
}

static int32_t wave(const note_t *n, sfx_player_t *p)
{
    int32_t s = sine[(p->phase >> 16) & (TABLE - 1)];
    switch (n->wave) {
    case W_BELL: return (s * 2 + sine[(p->phase >> 15) & (TABLE - 1)]) / 3; /* the fundamental and its octave */
    case W_BUZZ: { int32_t c = s * 3; return c > 32767 ? 32767 : c < -32767 ? -32767 : c; } /* a soft square */
    case W_CLICK: p->noise = (p->noise >> 1) ^ (-(int32_t)(p->noise & 1u) & 0xB400u); return (int32_t)(p->noise & 0xFFFF) - 32768;
    default: return s;
    }
}

static uint32_t frames_of(const note_t *n) { return (uint32_t)n->ms * BEEP_RATE_HZ / 1000; }
static bool held(const sound_t *s, int i) { return i >= 0 && i < s->count && s->n[i].vol && s->n[i].env == E_HOLD; }

static void advance(sfx_player_t *p, const sound_t *s)
{
    while (p->note < s->count && p->at >= frames_of(&s->n[p->note])) { p->note++; p->at = 0; }
}

bool sfx_fill(sfx_player_t *p, int16_t *out, size_t frames)
{
    const sound_t *s = sound(p->id);
    if (s) advance(p, s);
    bool any = s && p->note < s->count;
    for (size_t i = 0; i < frames; i++) {
        int32_t v = 0;
        if (s) advance(p, s);
        if (s && p->note < s->count) {
            const note_t *n = &s->n[p->note];
            uint32_t len = frames_of(n);
            if (n->vol) {
                uint32_t f = n->f0 + (uint32_t)(((int64_t)n->f1 - n->f0) * (int64_t)p->at / (int64_t)len); /* a straight glide */
                p->phase += (uint32_t)((uint64_t)f * TABLE * 65536 / BEEP_RATE_HZ);
                int32_t env = 1000; /* permille */
                if (n->env == E_PLUCK) {
                    uint32_t left = len - p->at;
                    env = p->at < 16 ? (int32_t)(p->at * 1000 / 16) : (int32_t)((uint64_t)left * left * 1000 / ((uint64_t)len * len)); /* fades as a square */
                } else if (p->at < EDGE_FRAMES && !held(s, p->note - 1)) env = (int32_t)(p->at * 1000 / EDGE_FRAMES);
                else if (len - p->at < EDGE_FRAMES && !held(s, p->note + 1)) env = (int32_t)((len - p->at) * 1000 / EDGE_FRAMES);
                /* held notes in a row join into one sliding sound: no dip between them */
                v = (int32_t)((int64_t)wave(n, p) * AMP / 32767 * n->vol / 100 * env / 1000);
            } else p->phase = 0;
            p->at++;
        }
        out[2 * i] = out[2 * i + 1] = (int16_t)v;
    }
    return any;
}
