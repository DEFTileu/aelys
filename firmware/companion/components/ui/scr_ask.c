/* Ask Aelys (design "5 · Голос · Спросить Элис"): the voice app. Hold the low key anywhere, or open it from the menu and press the top
 * key, to talk. Idle: the face and how to talk. Listening: bars round the edge follow the microphone. Thinking: the question in quotes,
 * an arc running round the edge. Answering: the reply as text while it is spoken.
 * Deviations from the design: the question appears once it is sent, not word by word (ElevenLabs transcribes it whole), and the reply
 * is one wrapped text rather than rows. The "task added" card is not here yet. */
#include <string.h>
#include "ui_screens_priv.h"

#define N_BARS 24
#define BAR_OUT 219 /* centre to the outer end of a bar */
#define BAR_MIN 10
#define BAR_MAX 34
#define BAR_MS 66   /* the bars' frame */
#define ARC_DEG 58  /* the thinking arc: 16 % of the ring */
#define ARC_MS 1400 /* one turn */
#define ARC_R (UI_SCREEN_SIZE / 2 - 16) /* the design's thin ring, 14 px in */

/* the design's bars, every 12 degrees clockwise from the top; the gaps keep the two keys' marks clear where the case puts them: the top key
 * 45 degrees round from the top, the low key 130 (ui_key_hint_place's 315 and 40, counted from 3 o'clock) */
static const int16_t bar_deg[N_BARS] = { 0, 12, 24, 72, 84, 96, 108, 156, 168, 180, 192, 204, 216, 228, 240, 252, 264, 276, 288, 300,
                                         312, 324, 336, 348 };

static struct {
    lv_obj_t *root, *bars, *arc, *face, *eb, *body, *hint, *low;
    lv_timer_t *tm;
    ask_view_t view;
    uint8_t len[N_BARS];
    uint32_t frame;
    int32_t arc_at; /* the thinking arc's start, degrees clockwise from the top */
    char question[201], reply[601];
} a;

static uint8_t (*level_src)(void);
void scr_ask_set_level_source(uint8_t (*fn)(void)) { level_src = fn; }

static void bar_ends(int i, int32_t len, lv_point_precise_t *p1, lv_point_precise_t *p2)
{
    int32_t sn = lv_trigo_sin(bar_deg[i]), cs = lv_trigo_cos(bar_deg[i]), c = UI_SCREEN_SIZE / 2;
    p1->x = c + sn * BAR_OUT / LV_TRIGO_SIN_MAX;
    p1->y = c - cs * BAR_OUT / LV_TRIGO_SIN_MAX;
    p2->x = c + sn * (BAR_OUT - len) / LV_TRIGO_SIN_MAX;
    p2->y = c - cs * (BAR_OUT - len) / LV_TRIGO_SIN_MAX;
}

/* Only the box round one bar at its longest: the ring of bars never redraws the face in the middle. */
static void invalidate_bar(int i)
{
    lv_point_precise_t p1, p2;
    bar_ends(i, BAR_MAX, &p1, &p2);
    lv_area_t r = { (int32_t)LV_MIN(p1.x, p2.x) - 4, (int32_t)LV_MIN(p1.y, p2.y) - 4, (int32_t)LV_MAX(p1.x, p2.x) + 4,
                    (int32_t)LV_MAX(p1.y, p2.y) + 4 };
    lv_obj_invalidate_area(a.bars, &r);
}

static void bars_draw(lv_event_t *e)
{
    lv_layer_t *layer = lv_event_get_layer(e);
    lv_draw_line_dsc_t l;
    lv_draw_line_dsc_init(&l);
    l.color = lv_color_hex(UI_COLOR_ACCENT);
    l.width = 4;
    l.round_start = l.round_end = true;
    for (int i = 0; i < N_BARS; i++) {
        bar_ends(i, a.len[i], &l.p1, &l.p2);
        lv_draw_line(layer, &l);
    }
}

/* Each bar wobbles on its own phase; the microphone level sets how far. */
static void tm_cb(lv_timer_t *t)
{
    (void)t;
    uint32_t lvl = level_src ? level_src() : 0;
    a.frame++;
    for (int i = 0; i < N_BARS; i++) {
        int32_t w = lv_trigo_sin((int16_t)((a.frame * (9 + i % 5 * 4) + i * 47) % 360)); /* -32767..32767 */
        int32_t span = (int32_t)(BAR_MAX - BAR_MIN) * (int32_t)lvl / 255;
        uint8_t len = (uint8_t)(BAR_MIN + span * (w + LV_TRIGO_SIN_MAX) / (2 * LV_TRIGO_SIN_MAX));
        if (len != a.len[i]) { a.len[i] = len; invalidate_bar(i); }
    }
}

static void arc_draw(lv_event_t *e)
{
    lv_draw_arc_dsc_t d;
    lv_draw_arc_dsc_init(&d);
    d.color = lv_color_hex(UI_COLOR_ACCENT);
    d.width = 4;
    d.rounded = true;
    d.center.x = d.center.y = UI_SCREEN_SIZE / 2;
    d.radius = ARC_R;
    d.start_angle = (270 + a.arc_at) % 360; /* LVGL counts from 3 o'clock */
    d.end_angle = (270 + a.arc_at + ARC_DEG) % 360;
    lv_draw_arc(lv_event_get_layer(e), &d);
}

/* The box round the arc that starts at deg: a turn redraws only the edge it passes, not the face. */
static void invalidate_arc(int32_t deg)
{
    lv_area_t r = { UI_SCREEN_SIZE, UI_SCREEN_SIZE, 0, 0 };
    for (int32_t k = 0; k <= ARC_DEG; k += ARC_DEG / 4) {
        int32_t x = UI_SCREEN_SIZE / 2 + lv_trigo_sin((int16_t)((deg + k) % 360)) * ARC_R / LV_TRIGO_SIN_MAX;
        int32_t y = UI_SCREEN_SIZE / 2 - lv_trigo_cos((int16_t)((deg + k) % 360)) * ARC_R / LV_TRIGO_SIN_MAX;
        r.x1 = LV_MIN(r.x1, x - 6); r.y1 = LV_MIN(r.y1, y - 6); r.x2 = LV_MAX(r.x2, x + 6); r.y2 = LV_MAX(r.y2, y + 6);
    }
    lv_obj_invalidate_area(a.arc, &r);
}

static void arc_anim(void *obj, int32_t v)
{
    (void)obj;
    invalidate_arc(a.arc_at);
    a.arc_at = v;
    invalidate_arc(v);
}

static void restack(void)
{
    lv_obj_t *col[] = { a.face, a.eb, a.body };
    static const uint8_t gap[] = { 0, 12, 8 };
    ui_stack(col, gap, 3, 0, UI_SCREEN_SIZE, -1);
}

void scr_ask_question(const char *text)
{
    strlcpy(a.question, text ? text : "", sizeof a.question);
}

void scr_ask_reply(const char *text)
{
    strlcpy(a.reply, text ? text : "", sizeof a.reply);
}

void scr_ask_set(ask_view_t v)
{
    char q[sizeof a.question + 8];
    bool listen = v == ASK_LISTEN, think = v == ASK_THINK;
    if (v != a.view) {
        a.view = v;
        face_set_mood(a.face, listen ? MOOD_ATTENTION : think ? MOOD_THINKING : v == ASK_ANSWER ? MOOD_HAPPY : MOOD_CALM);
        lv_obj_set_hidden(a.bars, !listen);
        if (listen) { lv_timer_reset(a.tm); lv_timer_resume(a.tm); }
        else lv_timer_pause(a.tm);
        lv_anim_delete(a.arc, arc_anim);
        lv_obj_set_hidden(a.arc, !think);
        if (think) {
            lv_anim_t an;
            lv_anim_init(&an);
            lv_anim_set_var(&an, a.arc);
            lv_anim_set_exec_cb(&an, arc_anim);
            lv_anim_set_values(&an, 0, 359);
            lv_anim_set_duration(&an, ARC_MS);
            lv_anim_set_repeat_count(&an, LV_ANIM_REPEAT_INFINITE);
            lv_anim_start(&an);
        }
    }
    ui_set_text(a.eb, listen ? "Listening" : think ? "Thinking" : v == ASK_ANSWER ? "Aelys" : "Ask Aelys");
    if (think && a.question[0]) {
        strcpy(q, "\xE2\x80\x9C"); /* the design's curly quotes */
        strlcat(q, a.question, sizeof q);
        strlcat(q, "\xE2\x80\x9D", sizeof q);
    }
    const char *body = listen ? "Speak now" : think ? (a.question[0] ? q : "") : v == ASK_ANSWER ? a.reply
                     : "Hold the lower button and talk";
    ui_set_text(a.body, body);
    ui_text_color(a.body, listen ? UI_COLOR_SUBTLE : UI_COLOR_TEXT);
    lv_obj_set_height(a.body, ui_text_height(body, &inter_20, 330, v == ASK_ANSWER ? 6 : 3));
    /* the keys: from the menu the top key talks and sends; a hold of the low key talks and its release sends */
    ui_set_text(a.hint, listen ? "Send" : "Talk");
    lv_obj_set_hidden(a.hint, think);
    ui_set_text(a.low, listen ? "Release" : "Back");
    restack();
}

lv_obj_t *scr_ask_create(lv_obj_t *parent)
{
    a.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    a.bars = ui_plain(a.root, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    lv_obj_set_user_flag(a.bars, 1, true); /* custom paint, see invalidate_painted() in screens.c */
    lv_obj_add_event_cb(a.bars, bars_draw, LV_EVENT_DRAW_MAIN, NULL);
    for (int i = 0; i < N_BARS; i++) a.len[i] = BAR_MIN;
    a.arc = ui_plain(a.root, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    lv_obj_set_user_flag(a.arc, 1, true); /* custom paint */
    lv_obj_add_event_cb(a.arc, arc_draw, LV_EVENT_DRAW_MAIN, NULL);
    a.face = face_create(a.root, 62); /* the design's 0.62 */
    a.eb = ui_label(a.root, &inter_16, UI_COLOR_ACCENT, 300, 1, LV_TEXT_ALIGN_CENTER);
    a.body = ui_label(a.root, &inter_20, UI_COLOR_TEXT, 330, 6, LV_TEXT_ALIGN_CENTER);
    /* at the keys, as the design's ".bt.t" and ".bt.b" */
    a.hint = ui_label(a.root, &inter_16, UI_COLOR_ACCENT, 90, 1, LV_TEXT_ALIGN_RIGHT);
    ui_key_hint_place(a.hint, false);
    a.low = ui_label(a.root, &inter_16, UI_COLOR_ACCENT, 90, 1, LV_TEXT_ALIGN_RIGHT);
    ui_key_hint_place(a.low, true);
    if (!a.tm) { /* a repeated setup (host tests) keeps the one timer */
        a.tm = lv_timer_create(tm_cb, BAR_MS, NULL);
    }
    lv_timer_pause(a.tm);
    a.view = ASK_LISTEN; /* not IDLE, so the first set applies everything */
    a.question[0] = a.reply[0] = '\0';
    scr_ask_set(ASK_IDLE);
    return a.root;
}
