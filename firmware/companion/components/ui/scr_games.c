/* Games (design "Игры"): a hub and five small games, one screen. Swipe turns the hub between Ask Aelys, Coin, Dice, Reaction and the
 * Tilt Maze, a tap or the top key opens one, the low key goes back to the hub and then to the menu. In a game a tap (or the top key) plays:
 *   Ask Aelys  a "thinking" face for a second, then one of twelve short answers;
 *   Coin       flips (the coin squashes edge-on and back a few times) and shows Heads or Tails;
 *   Dice       the faces flick past, slower and slower, and stop on 1..6;
 *   Reaction   wait 1.5-4 s, the screen turns green, tap: the time in ms and the best of this session; too early is "Too soon";
 *   Tilt Maze  the ball follows the board's tilt (UI_EV_LEVEL's gravity x/y) to the ring in the far corner; the time of the best run is kept.
 * The rules and the physics are in games_core.c (host-tested); this file draws them. Nothing here sounds, listens or touches the network.
 * Objects are created once. The only timer is paused unless a wait, a thought or the maze runs; the coin and the dice use one lv_anim each.
 * Deviations from the design: a tap replaces "shake" (the board's shake gesture does not exist yet), the coin's star is an outline, no noise meter
 * (it would need the microphone). */
#include <stdio.h>
#include <string.h>
#include "games_core.h"
#include "ui_screens_priv.h"

typedef enum { G_ASK, G_COIN, G_DICE, G_REACT, G_MAZE, G_COUNT } game_t;

#define COLOR_HUB 0x5FD7A8
#define COLOR_AMBER UI_COLOR_AMBER
#define COLOR_ITEM_BG 0x16141C
#define COLOR_WALL 0x3A3546
#define COLOR_COIN 0xE9BD66
#define COLOR_COIN_RIM 0xD9A64A
#define COLOR_COIN_INK 0x7A5714
#define COLOR_DIE 0xF1EEF6
#define COLOR_PIP 0x1C1B22
#define COLOR_GREEN 0x5FD7A8
#define COLOR_GREEN_INK 0x06241A
#define HUB_D 132
#define COIN_D 170
#define DIE_D 150
#define PIP_D 26
#define BOARD_OUT (MZ_SIZE + 12) /* the board plus its 6 px rim */
#define THINK_MS 1100
#define FLIP_MS 900
#define ROLL_MS 900
#define FRAME_MS 33
#define STEPS 9 /* faces that flick past before the dice stop */

static const struct { const char *name, *sub; uint32_t color; } info[G_COUNT] = {
    { "Ask Aelys", "Magic answers", 0xB9A8FF },
    { "Coin", "Heads or tails", COLOR_AMBER },
    { "Dice", "Roll 1 to 6", 0xB9A8FF },
    { "Reaction", "How fast are you?", COLOR_GREEN },
    { "Tilt Maze", "Roll it home", COLOR_AMBER },
};

static struct {
    lv_obj_t *root, *eb, *big, *sub, *note, *hint, *dot[G_COUNT], *hub[G_COUNT];
    lv_obj_t *face, *coin, *disc, *star, *tail, *die, *pip[7], *go, *rx_ms, *board, *ball;
    lv_timer_t *tm;
    game_t sel;
    bool open;
    unsigned last_ans, ans;       /* Ask: the last answer; GM_N_ANSWERS = none */
    bool thinking;
    bool tails, flip_tails, flipping; /* Coin: the side up, the side it lands on */
    unsigned face_up, face_to;    /* Dice: the face showing, the face it lands on (0 = not rolled yet) */
    bool rolling;
    int32_t flick;                /* Dice: the faces shown so far in this roll */
    rx_t rx;
    mz_t mz;
    uint32_t mz_tick;
    int32_t gx, gy;               /* the newest tilt */
} s;

static uint32_t xorshift(void)
{
    static uint32_t x = 2463534242u;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return x;
}
static uint32_t (*rnd)(void) = xorshift;
void ui_set_random(uint32_t (*fn)(void)) { rnd = fn ? fn : xorshift; }

static void mmss(char out[8], uint32_t ms) { snprintf(out, 8, "%u:%02u", (unsigned)(ms / 60000 % 100), (unsigned)(ms / 1000 % 60)); }

/* ---- layout ---- */

static void set_big(const char *txt, const lv_font_t *f, uint32_t color)
{
    if (lv_obj_get_style_text_font(s.big, LV_PART_MAIN) != f) lv_obj_set_style_text_font(s.big, f, 0);
    ui_set_text(s.big, txt);
    ui_text_color(s.big, color);
    lv_obj_set_height(s.big, ui_text_height(txt, f, 300, 2));
}

/* One screen state: which stage object shows and the text lines around it (NULL = line hidden). */
static void compose(const char *eb, uint32_t eb_color, lv_obj_t *stage, const char *big, const lv_font_t *bf, uint32_t big_color,
                    const char *sub, const char *note, const char *hint, uint32_t hint_color)
{
    lv_obj_t *stages[] = { s.hub[0], s.hub[1], s.hub[2], s.hub[3], s.hub[4], s.face, s.coin, s.die, s.go, s.rx_ms, s.board };
    for (unsigned i = 0; i < sizeof stages / sizeof *stages; i++) lv_obj_set_hidden(stages[i], stages[i] != stage);
    for (int i = 0; i < G_COUNT; i++) lv_obj_set_hidden(s.dot[i], stage != s.hub[s.sel]);
    if (eb) { ui_set_text(s.eb, eb); ui_text_color(s.eb, eb_color); }
    if (big) set_big(big, bf, big_color);
    if (sub) ui_set_text(s.sub, sub);
    if (note) ui_set_text(s.note, note);
    lv_obj_set_hidden(s.eb, !eb);
    lv_obj_set_hidden(s.big, !big);
    lv_obj_set_hidden(s.sub, !sub);
    lv_obj_set_hidden(s.note, !note);
    lv_obj_set_hidden(s.hint, !hint);
    if (hint) { ui_set_text(s.hint, hint); ui_text_color(s.hint, hint_color); }
    if (stage == s.board) { /* the board and its two lines have their own places */
        lv_obj_set_pos(s.eb, (UI_SCREEN_SIZE - 300) / 2, 58);
        lv_obj_set_pos(s.sub, (UI_SCREEN_SIZE - 300) / 2, 392);
        return;
    }
    lv_obj_t *all[] = { s.eb, stage, s.big, s.sub, s.note }, *col[5];
    const uint8_t all_gap[] = { 0, 14, 12, 8, 4 };
    uint8_t gap[5];
    int n = 0;
    for (int i = 0; i < 5; i++)
        if (all[i]) { col[n] = all[i]; gap[n++] = all_gap[i]; } /* the first slot's gap is never used */
    ui_stack(col, gap, n, 0, UI_SCREEN_SIZE, -1);
}

static void best_text(char out[24], game_t g)
{
    char t[8];
    out[0] = 0;
    if (g == G_REACT && s.rx.best_ms) snprintf(out, 24, "Best %u ms", (unsigned)s.rx.best_ms);
    else if (g == G_MAZE && s.mz.best_ms) { mmss(t, s.mz.best_ms); snprintf(out, 24, "Best %s", t); }
}

static void draw_dice(unsigned face)
{
    unsigned m = gm_die_pips(face);
    for (int i = 0; i < 7; i++) lv_obj_set_hidden(s.pip[i], !(m >> i & 1));
}

static void draw_coin(bool tails, int32_t h)
{
    if (lv_obj_get_height(s.disc) != h) lv_obj_set_height(s.disc, h);
    lv_obj_set_hidden(s.star, tails || h < 90);
    lv_obj_set_hidden(s.tail, !tails || h < 90);
}

static void place_ball(void)
{
    lv_obj_set_pos(s.ball, (int32_t)s.mz.x - MZ_BALL_R, (int32_t)s.mz.y - MZ_BALL_R);
}

static void maze_text(void)
{
    char t[8], u[8], line[40] = "";
    if (s.mz.won) {
        mmss(t, s.mz.elapsed_ms);
        mmss(u, s.mz.best_ms);
        snprintf(line, sizeof line, "Done %s \xC2\xB7 Best %s", t, u);
    } else if (s.mz.started) {
        mmss(t, s.mz.elapsed_ms);
        snprintf(line, sizeof line, "%s", t);
    } else {
        best_text(line, G_MAZE);
    }
    ui_set_text(s.sub, line);
    lv_obj_set_hidden(s.sub, !line[0]);
}

static void redraw(void)
{
    char best[24];
    if (!s.open) {
        best_text(best, s.sel);
        compose("Games", COLOR_HUB, s.hub[s.sel], info[s.sel].name, &inter_28, UI_COLOR_TEXT, best[0] ? best : info[s.sel].sub, NULL,
                "Open", info[s.sel].color);
        for (int i = 0; i < G_COUNT; i++) {
            lv_color_t c = lv_color_hex(i == (int)s.sel ? UI_COLOR_TEXT : COLOR_WALL);
            if (!lv_color_eq(lv_obj_get_style_bg_color(s.dot[i], LV_PART_MAIN), c)) lv_obj_set_style_bg_color(s.dot[i], c, 0);
        }
        return;
    }
    uint32_t col = info[s.sel].color;
    switch (s.sel) {
    case G_ASK:
        if (s.thinking) compose("Ask Aelys", col, s.face, "Hmm\xE2\x80\xA6", &inter_28, UI_COLOR_MUTED, " ", NULL, NULL, 0);
        else if (s.ans < GM_N_ANSWERS) compose("Ask Aelys", col, s.face, gm_answer(s.ans)->text, &inter_28, UI_COLOR_TEXT, "Tap to ask again", NULL, "Ask", col);
        else compose("Ask Aelys", col, s.face, "Think of a question", &inter_28, UI_COLOR_TEXT, "Tap for an answer", NULL, "Ask", col);
        break;
    case G_COIN:
        if (s.flipping) compose(NULL, 0, s.coin, "Flipping\xE2\x80\xA6", &inter_40, UI_COLOR_MUTED, "Tap to flip", NULL, "Flip", col);
        else compose(NULL, 0, s.coin, s.tails ? "Tails" : "Heads", &inter_40, UI_COLOR_TEXT, "Tap to flip", NULL, "Flip", col);
        break;
    case G_DICE: {
        char t[16];
        snprintf(t, sizeof t, "Rolled %u", s.face_up);
        if (s.rolling) compose(NULL, 0, s.die, "Rolling\xE2\x80\xA6", &inter_40, UI_COLOR_MUTED, "Tap to roll", NULL, "Roll", col);
        else compose(NULL, 0, s.die, s.face_up ? t : "Roll the dice", &inter_40, UI_COLOR_TEXT, "Tap to roll", NULL, "Roll", col);
        break;
    }
    case G_REACT:
        best_text(best, G_REACT);
        if (s.rx.st == RX_WAIT) compose("Get ready", col, NULL, "Wait\xE2\x80\xA6", &inter_40, UI_COLOR_TEXT, "Tap when it turns green", NULL, NULL, 0);
        else if (s.rx.st == RX_GO) compose(NULL, 0, s.go, NULL, NULL, 0, NULL, NULL, NULL, 0);
        else if (s.rx.st == RX_DONE) {
            char ms[12];
            snprintf(ms, sizeof ms, "%u", (unsigned)s.rx.ms);
            ui_set_text(s.rx_ms, ms);
            compose(NULL, 0, s.rx_ms, NULL, NULL, 0, "ms", best, "Again", col);
        } else if (s.rx.st == RX_EARLY) compose("Reaction", col, NULL, "Too soon", &inter_40, UI_COLOR_DANGER, "Wait for green", "Tap to retry", "Retry", col);
        else compose("Reaction", col, NULL, "Tap to start", &inter_40, UI_COLOR_TEXT, "Tap when it turns green", best[0] ? best : NULL, "Start", col);
        break;
    default: /* G_MAZE */
        compose("Tilt to roll", UI_COLOR_SUBTLE, s.board, NULL, NULL, 0, "", NULL, NULL, 0); /* the board covers the top key's corner */
        maze_text();
        place_ball();
        break;
    }
}

/* ---- play ---- */

/* The shared timer runs only while something needs it: a thought, the wait of the reaction game, the maze. */
static void timer_on(uint32_t ms)
{
    lv_timer_set_period(s.tm, ms ? ms : 1);
    lv_timer_reset(s.tm);
    lv_timer_resume(s.tm);
}
static void timer_off(void) { lv_timer_pause(s.tm); }

static void maze_tick(void)
{
    uint32_t now = lv_tick_get();
    mz_step(&s.mz, s.gx, s.gy, now - s.mz_tick);
    s.mz_tick = now;
    place_ball();
    maze_text();
    if (s.mz.won) timer_off();
}

static void tm_cb(lv_timer_t *t)
{
    (void)t;
    if (!s.open) { timer_off(); return; }
    if (s.sel == G_MAZE) {
        maze_tick();
    } else if (s.sel == G_ASK && s.thinking) {
        s.thinking = false;
        s.ans = gm_ask_pick(s.last_ans, rnd());
        s.last_ans = s.ans;
        gm_tone_t tone = gm_answer(s.ans)->tone;
        face_set_mood(s.face, tone == GM_YES ? MOOD_HAPPY : tone == GM_NO ? MOOD_WORRIED : MOOD_CURIOUS);
        timer_off();
        redraw();
    } else if (s.sel == G_REACT) {
        uint32_t now = lv_tick_get();
        if (rx_poll(&s.rx, now)) { timer_off(); redraw(); }
        else timer_on(rx_wait_left(&s.rx, now));
    }
}

static void coin_cb(void *var, int32_t v)
{
    (void)var;
    int32_t halves = s.flip_tails == s.tails ? 6 : 7; /* half turns: odd lands on the other side */
    int32_t a = v * halves * 180 / 1000;
    int32_t c = lv_trigo_cos((int16_t)(a % 360));
    int32_t h = COIN_D * (c < 0 ? -c : c) / LV_TRIGO_SIN_MAX;
    draw_coin(s.tails ^ ((a / 180) & 1), h < 14 ? 14 : h);
}

static void coin_done(lv_anim_t *a)
{
    (void)a;
    s.flipping = false;
    s.tails = s.flip_tails;
    draw_coin(s.tails, COIN_D);
    redraw();
}

static void flip(void)
{
    if (s.flipping) return;
    s.flipping = true;
    s.flip_tails = gm_coin_tails(rnd());
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, s.coin);
    lv_anim_set_exec_cb(&a, coin_cb);
    lv_anim_set_completed_cb(&a, coin_done);
    lv_anim_set_values(&a, 0, 1000);
    lv_anim_set_duration(&a, FLIP_MS);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    lv_anim_start(&a);
    redraw();
}

static void die_cb(void *var, int32_t v)
{
    (void)var;
    int32_t step = v * STEPS / 1000;
    if (step == s.flick) return;
    s.flick = step;
    s.face_up = step >= STEPS ? s.face_to : (s.face_to + 2 * (unsigned)step) % 6 + 1; /* never random, always moving */
    draw_dice(s.face_up);
}

static void die_done(lv_anim_t *a)
{
    (void)a;
    s.rolling = false;
    s.face_up = s.face_to;
    draw_dice(s.face_up);
    redraw();
}

static void roll(void)
{
    if (s.rolling) return;
    s.rolling = true;
    s.face_to = gm_die(rnd());
    s.flick = -1;
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, s.die);
    lv_anim_set_exec_cb(&a, die_cb);
    lv_anim_set_completed_cb(&a, die_done);
    lv_anim_set_values(&a, 0, 1000);
    lv_anim_set_duration(&a, ROLL_MS);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    lv_anim_start(&a);
    redraw();
}

/* Everything that runs stops: leaving the screen, or backing out of a game. A reaction wait is dropped, the best time stays. */
static void stop_play(void)
{
    timer_off();
    lv_anim_delete(s.coin, coin_cb);
    lv_anim_delete(s.die, die_cb);
    if (s.flipping) { s.flipping = false; draw_coin(s.tails, COIN_D); }
    if (s.rolling) { s.rolling = false; s.face_up = s.face_to; draw_dice(s.face_up); }
    if (s.thinking) { s.thinking = false; face_set_mood(s.face, MOOD_CURIOUS); }
    if (s.rx.st == RX_WAIT || s.rx.st == RX_GO) s.rx.st = RX_IDLE;
}

static void maze_start(void)
{
    mz_reset(&s.mz);
    s.mz_tick = lv_tick_get();
    timer_on(FRAME_MS);
}

void scr_games_visible(bool on)
{
    stop_play();
    s.open = false;
    if (on) redraw();
}

void scr_games_swipe(int dir)
{
    if (s.open) return;
    s.sel = (game_t)((s.sel + (dir < 0 ? G_COUNT - 1 : 1)) % G_COUNT);
    redraw();
}

void scr_games_top(void)
{
    uint32_t now = lv_tick_get();
    if (!s.open) {
        s.open = true;
        s.ans = GM_N_ANSWERS;
        s.face_up = 0;
        s.rx.st = RX_IDLE;
        if (s.sel == G_ASK) face_set_mood(s.face, MOOD_CURIOUS);
        if (s.sel == G_MAZE) maze_start();
        draw_dice(6);
        draw_coin(s.tails, COIN_D);
        redraw();
        return;
    }
    switch (s.sel) {
    case G_ASK:
        if (s.thinking) return;
        s.thinking = true;
        face_set_mood(s.face, MOOD_THINKING);
        timer_on(THINK_MS);
        redraw();
        break;
    case G_COIN: flip(); break;
    case G_DICE: roll(); break;
    case G_REACT:
        rx_tap(&s.rx, now, rnd());
        if (s.rx.st == RX_WAIT) timer_on(rx_wait_left(&s.rx, now));
        else timer_off();
        redraw();
        break;
    default: maze_start(); redraw(); break;
    }
}

void scr_games_tap(void) { scr_games_top(); }

bool scr_games_back(void)
{
    if (!s.open) return false;
    stop_play();
    s.open = false;
    redraw();
    return true;
}

int scr_games_selected(void) { return s.sel; }

void scr_games_tilt(int32_t gx, int32_t gy)
{
    s.gx = gx;
    s.gy = gy;
}

/* ---- widgets ---- */

static lv_obj_t *shape(lv_obj_t *parent, int32_t w, int32_t h, int32_t radius, uint32_t color)
{
    lv_obj_t *o = ui_plain(parent, w, h);
    lv_obj_set_style_radius(o, radius, 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(o, lv_color_hex(color), 0);
    return o;
}

static lv_obj_t *disc(lv_obj_t *parent, int32_t d, uint32_t color, int32_t dx, int32_t dy)
{
    lv_obj_t *o = shape(parent, d, d, LV_RADIUS_CIRCLE, color);
    lv_obj_align(o, LV_ALIGN_CENTER, dx, dy);
    return o;
}

/* The hub's picture of each game: a dark disc with a ring in the game's colour and a tiny version of the game inside. */
static lv_obj_t *hub_icon(lv_obj_t *parent, game_t g)
{
    lv_obj_t *h = shape(parent, HUB_D, HUB_D, LV_RADIUS_CIRCLE, COLOR_ITEM_BG);
    lv_obj_set_style_border_width(h, 3, 0);
    lv_obj_set_style_border_color(h, lv_color_hex(info[g].color), 0);
    switch (g) {
    case G_ASK: {
        lv_obj_t *q = ui_label(h, &inter_40, info[g].color, 60, 1, LV_TEXT_ALIGN_CENTER);
        lv_label_set_text(q, "?");
        lv_obj_center(q);
        break;
    }
    case G_COIN:
        disc(disc(h, 76, COLOR_COIN_RIM, 0, 0), 56, COLOR_COIN, 0, 0);
        disc(h, 18, COLOR_COIN_INK, 0, 0);
        break;
    case G_DICE: {
        lv_obj_t *d = shape(h, 72, 72, 16, COLOR_DIE);
        lv_obj_center(d);
        for (int i = -1; i <= 1; i++) disc(d, 13, COLOR_PIP, i * 18, i * 18);
        break;
    }
    case G_REACT:
        disc(h, 70, COLOR_GREEN, 0, 0);
        break;
    default: { /* G_MAZE */
        lv_obj_t *b = ui_plain(h, 76, 76);
        lv_obj_center(b);
        lv_obj_set_style_border_width(b, 4, 0);
        lv_obj_set_style_border_color(b, lv_color_hex(COLOR_WALL), 0);
        lv_obj_set_style_radius(b, 8, 0);
        disc(b, 14, 0xB9A8FF, -14, -14);
        lv_obj_t *g2 = disc(b, 18, COLOR_ITEM_BG, 14, 14);
        lv_obj_set_style_border_width(g2, 3, 0);
        lv_obj_set_style_border_color(g2, lv_color_hex(COLOR_AMBER), 0);
        break;
    }
    }
    return h;
}

static void star_draw(lv_event_t *e) /* the heads side: a four-pointed star in the design's polygon, as an outline */
{
    static const int8_t pt[9][2] = { { 32, 0 }, { 39, 25 }, { 64, 32 }, { 39, 39 }, { 32, 64 }, { 25, 39 }, { 0, 32 }, { 25, 25 }, { 32, 0 } };
    lv_area_t a;
    lv_obj_get_coords(lv_event_get_target_obj(e), &a);
    lv_draw_line_dsc_t l;
    lv_draw_line_dsc_init(&l);
    l.color = lv_color_hex(COLOR_COIN_INK);
    l.width = 6;
    l.round_start = l.round_end = true;
    for (int i = 0; i < 8; i++) {
        l.p1.x = a.x1 + pt[i][0]; l.p1.y = a.y1 + pt[i][1];
        l.p2.x = a.x1 + pt[i + 1][0]; l.p2.y = a.y1 + pt[i + 1][1];
        lv_draw_line(lv_event_get_layer(e), &l);
    }
}

lv_obj_t *scr_games_create(lv_obj_t *parent)
{
    s.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    s.eb = ui_label(s.root, &inter_16, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    s.big = ui_label(s.root, &inter_28, UI_COLOR_TEXT, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_long_mode(s.big, LV_LABEL_LONG_MODE_WRAP);
    s.sub = ui_label(s.root, &inter_20, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    s.note = ui_label(s.root, &inter_16, UI_COLOR_MUTED, 300, 1, LV_TEXT_ALIGN_CENTER);
    for (int i = 0; i < G_COUNT; i++) {
        s.hub[i] = hub_icon(s.root, (game_t)i);
        s.dot[i] = shape(s.root, 8, 8, LV_RADIUS_CIRCLE, COLOR_WALL);
        lv_obj_set_pos(s.dot[i], (UI_SCREEN_SIZE - (5 * 8 + 4 * 14)) / 2 + i * 22, 372);
    }
    /* Ask Aelys: the face at the design's 0.55 zoom */
    s.face = face_create(s.root, 55);
    face_set_mood(s.face, MOOD_CURIOUS);
    /* Coin: a gold disc that squashes edge-on while it spins, with a star (heads) or a 1 (tails) */
    s.coin = ui_plain(s.root, COIN_D, COIN_D);
    s.disc = shape(s.coin, COIN_D, COIN_D, LV_RADIUS_CIRCLE, COLOR_COIN);
    lv_obj_set_style_border_width(s.disc, 10, 0);
    lv_obj_set_style_border_color(s.disc, lv_color_hex(COLOR_COIN_RIM), 0);
    lv_obj_center(s.disc);
    s.star = ui_plain(s.disc, 64, 64);
    lv_obj_set_user_flag(s.star, 1, true); /* custom paint, see invalidate_painted() in screens.c */
    lv_obj_add_event_cb(s.star, star_draw, LV_EVENT_DRAW_MAIN, NULL);
    lv_obj_center(s.star);
    s.tail = ui_label(s.disc, &inter_40, COLOR_COIN_INK, 60, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(s.tail, "1");
    lv_obj_center(s.tail);
    lv_obj_set_hidden(s.tail, true);
    /* Dice: a light rounded square with seven spots, shown as the face needs */
    s.die = shape(s.root, DIE_D, DIE_D, 30, COLOR_DIE);
    for (int i = 0; i < 7; i++) {
        static const int8_t at[7][2] = { { 0, 0 }, { 2, 0 }, { 0, 1 }, { 1, 1 }, { 2, 1 }, { 0, 2 }, { 2, 2 } }; /* grid of three, as gm_die_pips counts */
        s.pip[i] = disc(s.die, PIP_D, COLOR_PIP, (at[i][0] - 1) * 41, (at[i][1] - 1) * 41);
    }
    /* Reaction: the green circle, and the digits of the result */
    s.go = shape(s.root, 330, 330, LV_RADIUS_CIRCLE, COLOR_GREEN);
    lv_obj_t *tap = ui_label(s.go, &inter_40, COLOR_GREEN_INK, 200, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(tap, "Tap!");
    lv_obj_center(tap);
    s.rx_ms = ui_label(s.root, &inter_clock_96, UI_COLOR_TEXT, 330, 1, LV_TEXT_ALIGN_CENTER);
    /* Maze: the board with its rim, the design's seven walls, the goal ring and the ball. The board's own position is its place on the screen. */
    s.board = ui_plain(s.root, BOARD_OUT, BOARD_OUT);
    lv_obj_set_pos(s.board, (UI_SCREEN_SIZE - BOARD_OUT) / 2, (UI_SCREEN_SIZE - BOARD_OUT) / 2);
    lv_obj_set_style_border_width(s.board, 6, 0);
    lv_obj_set_style_border_color(s.board, lv_color_hex(COLOR_WALL), 0);
    lv_obj_set_style_radius(s.board, 10, 0);
    for (unsigned i = 0; i < MZ_N_WALLS; i++) {
        const mz_wall_t *w = mz_wall(i);
        lv_obj_set_pos(shape(s.board, w->w, w->h, 3, COLOR_WALL), w->x, w->y);
    }
    lv_obj_t *ring = ui_plain(s.board, 36, 36);
    lv_obj_set_pos(ring, 210, 210);
    lv_obj_set_style_radius(ring, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(ring, 4, 0);
    lv_obj_set_style_border_color(ring, lv_color_hex(COLOR_AMBER), 0);
    s.ball = shape(s.board, 2 * MZ_BALL_R, 2 * MZ_BALL_R, LV_RADIUS_CIRCLE, 0xB9A8FF);
    s.hint = ui_label(s.root, &inter_16, UI_COLOR_ACCENT, 90, 1, LV_TEXT_ALIGN_RIGHT);
    lv_obj_set_pos(s.hint, 394 - 90, 98); /* at the top key, like Focus and Timer */
    s.last_ans = s.ans = GM_N_ANSWERS;
    rx_init(&s.rx);
    mz_reset(&s.mz);
    if (!s.tm) { /* a repeated setup (host tests) keeps the one timer */
        s.tm = lv_timer_create(tm_cb, FRAME_MS, NULL);
        lv_timer_pause(s.tm);
    }
    s.open = s.thinking = s.flipping = s.rolling = s.tails = false;
    s.sel = G_ASK;
    redraw();
    return s.root;
}
