/* Settings (design "Настройки", "Wi-Fi · сохранённые сети"): the list behind the menu's Settings item, and the two screens it opens.
 * List: Brightness (steps 20..100 %), Sleep after (shown dim with "Soon": the firmware has none), Sounds (a switch, off at first: the
 * small sound effects, never at night), Always level (the switch for the 1 s hold on the home face), Wi-Fi and About. A swipe moves the highlight, the top key or a tap on a row acts on it:
 * brightness goes to the next step (a tap on the bar sets the step under the finger), the switch flips, Wi-Fi and About open. The low key
 * goes back. Wi-Fi is view only: the saved names in priority order (names only: the passwords never leave main), the network in use
 * and the state; networks are added, removed and re-ordered in the app. About: firmware, battery, pairing.
 * What the owner picks goes out through ui_settings_hooks_t (screens do not touch the panel, flash or the PMIC).
 * Brightness rule (main/app_main.c has the other half): a step set here is applied at once and saved a moment later in the same "settings"
 * blob the server writes, WITHOUT touching its rev. So a server settings command with a newer rev still wins (it overwrites the value and
 * drops a save that is still pending), a replay of an old rev is dropped as stale and the board's own choice stays across a reboot.
 * Deviations: no icon font, so no signal-strength icon and no phone icon; no separator lines (the highlight shows the row);
 * the scroll arc at the left edge follows the highlight. */
#include <stdio.h>
#include <string.h>
#include "ui_screens_priv.h"

#define ROW_W 320
#define ROW_H 46
#define NET_H 58
#define PAD 14
#define BAR_X 170
#define BAR_W 84
#define BAR_H 8
#define SW_W 48
#define SW_H 28
#define KNOB 22
#define NUM_D 26
#define COLOR_ROW_SEL 0x1C1A23
#define COLOR_BAR_TRACK 0x2A2733
#define COLOR_SW_OFF 0x3A3546
#define COLOR_SW_ON 0x6A4CF2
#define COLOR_OK 0x5FD7A8
#define COLOR_ARC_TRACK 0x17151D
#define COLOR_ARC_THUMB 0x5A5466
#define ARC_W 6
#define ARC_R 219 /* outer radius: the design's thin ring, 14 px inside the display */
#define ARC_FROM 160 /* LVGL degrees: the design's 250 deg (clockwise from 12 o'clock), 72 deg long, thumb 30 deg */

typedef enum { R_BRIGHT, R_SLEEP, R_SOUNDS, R_LEVEL, R_WIFI, R_ABOUT, N_ROWS } row_id_t;
static const struct { const char *name; bool on; scr_t target; } rows[N_ROWS] = {
    { "Brightness", true, SCR_SETTINGS }, { "Sleep after", false, SCR_SETTINGS }, { "Sounds", true, SCR_SETTINGS },
    { "Always level", true, SCR_SETTINGS }, { "Wi-Fi", true, SCR_WIFI }, { "About", true, SCR_ABOUT },
};
static const uint8_t steps[] = { 20, 40, 60, 80, 100 };

static const ui_settings_hooks_t *hooks;
static uint8_t pct = BRIGHTNESS_MAX;
static uint8_t wifi_state; /* ui_wifi_state_t */
static char wifi_cur[33];  /* the network in use, "" when none */

static struct {
    lv_obj_t *root, *head, *arc, *row[N_ROWS], *name[N_ROWS], *val[N_ROWS], *bar, *fill, *sw[N_ROWS], *knob[N_ROWS]; /* sw: the two switch rows */
    int sel, drawn_sel; /* highlight; the one the arc was drawn for */
    int drawn_pct, drawn_sw[N_ROWS];
} l;

static struct {
    lv_obj_t *root, *head, *arc, *row[WIFI_MAX], *num[WIFI_MAX], *name[WIFI_MAX], *stat[WIFI_MAX], *foot;
} w;

static struct {
    lv_obj_t *root, *head, *row[3], *name[3], *val[3];
    uint32_t read_ms;
    char battery[20];
} a;

void ui_set_settings_hooks(const ui_settings_hooks_t *h) { hooks = h; }

void ui_settings_init(uint8_t brightness_pct, bool level_on, bool sound_on)
{
    pct = brightness_pct < BRIGHTNESS_MIN ? BRIGHTNESS_MIN : brightness_pct > BRIGHTNESS_MAX ? BRIGHTNESS_MAX : brightness_pct;
    ui_level_set(level_on, false);
    ui_sound_set(sound_on, false);
}

void scr_settings_note_brightness(uint8_t p)
{
    if (p >= BRIGHTNESS_MIN && p <= BRIGHTNESS_MAX) pct = p; /* the server's change, or main echoing a step */
}

void scr_settings_level_changed(bool on)
{
    if (hooks && hooks->level) hooks->level(on);
}

void scr_settings_sound_changed(bool on)
{
    if (hooks && hooks->sound) hooks->sound(on);
}

void scr_settings_set_wifi(uint8_t state, const char *cur)
{
    wifi_state = state;
    snprintf(wifi_cur, sizeof wifi_cur, "%s", cur);
}

/* ---- the scroll arc (a custom paint: see invalidate_painted() in screens.c) ---- */

static void arc_paint(lv_event_t *e)
{
    lv_area_t box;
    lv_obj_get_coords(lv_event_get_target_obj(e), &box);
    const int *sel = lv_event_get_user_data(e);
    lv_draw_arc_dsc_t d;
    lv_draw_arc_dsc_init(&d);
    d.width = ARC_W;
    d.center.x = box.x1 + UI_SCREEN_SIZE / 2;
    d.center.y = box.y1 + UI_SCREEN_SIZE / 2;
    d.radius = ARC_R;
    d.color = lv_color_hex(COLOR_ARC_TRACK);
    d.start_angle = ARC_FROM;
    d.end_angle = ARC_FROM + 72;
    lv_draw_arc(lv_event_get_layer(e), &d);
    d.color = lv_color_hex(COLOR_ARC_THUMB);
    d.start_angle = (lv_value_precise_t)(ARC_FROM + 42 - *sel * 42 / (N_ROWS - 1)); /* the first row at the top end */
    d.end_angle = d.start_angle + 30;
    lv_draw_arc(lv_event_get_layer(e), &d);
}

static lv_obj_t *arc_create(lv_obj_t *parent, int *sel)
{
    lv_obj_t *o = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    lv_obj_set_user_flag(o, 1, true);
    lv_obj_add_event_cb(o, arc_paint, LV_EVENT_DRAW_MAIN, sel);
    return o;
}

/* ---- the list ---- */

static void pct_text(char out[8], int v) { snprintf(out, 8, "%d%%", v); }

static void wifi_value(char *out, size_t cap)
{
    snprintf(out, cap, "%s", wifi_state == UI_WIFI_ONLINE ? (wifi_cur[0] ? wifi_cur : "Connected") :
                             wifi_state == UI_WIFI_CONNECTING ? "Connecting" : wifi_state == UI_WIFI_BAD_PASSWORD ? "Wrong password" : "Offline");
}

void scr_settings_set(void)
{
    char t[40];
    ui_set_text(l.head, "SETTINGS");
    for (int i = 0; i < N_ROWS; i++) {
        bool sel = i == l.sel;
        lv_opa_t opa = sel ? LV_OPA_COVER : LV_OPA_TRANSP;
        if (lv_obj_get_style_bg_opa(l.row[i], LV_PART_MAIN) != opa) lv_obj_set_style_bg_opa(l.row[i], opa, 0);
    }
    if (l.drawn_sel != l.sel) { l.drawn_sel = l.sel; lv_obj_invalidate(l.arc); }
    if (l.drawn_pct != pct) {
        l.drawn_pct = pct;
        lv_obj_set_width(l.fill, BAR_W * (pct - BRIGHTNESS_MIN) / (BRIGHTNESS_MAX - BRIGHTNESS_MIN) + 2);
        pct_text(t, pct);
        ui_set_text(l.val[R_BRIGHT], t);
    }
    for (int i = R_SOUNDS; i <= R_LEVEL; i++) { /* the two switch rows, next to each other */
        int on = i == R_LEVEL ? ui_level_on() : ui_sound_on();
        if (l.drawn_sw[i] == on) continue;
        l.drawn_sw[i] = on;
        lv_obj_set_style_bg_color(l.sw[i], lv_color_hex(on ? COLOR_SW_ON : COLOR_SW_OFF), 0);
        lv_obj_set_x(l.knob[i], on ? SW_W - KNOB - 3 : 3);
    }
    wifi_value(t, sizeof t);
    ui_set_text(l.val[R_WIFI], t);
    ui_text_color(l.val[R_WIFI], wifi_state == UI_WIFI_BAD_PASSWORD ? UI_COLOR_DANGER : UI_COLOR_SUBTLE);
    ui_set_text(l.val[R_ABOUT], hooks && hooks->version ? hooks->version() : "");
}

void scr_settings_step(int dir)
{
    for (int n = 0; n < N_ROWS; n++) {
        l.sel = (l.sel + (dir < 0 ? N_ROWS - 1 : 1)) % N_ROWS;
        if (rows[l.sel].on) break;
    }
    scr_settings_set();
}

static void set_brightness(int v)
{
    if (v == pct) return;
    pct = (uint8_t)v;
    if (hooks && hooks->brightness) hooks->brightness(pct);
}

static scr_t activate(int i)
{
    if (!rows[i].on) return SCR_SETTINGS;
    if (i == R_BRIGHT) {
        int next = steps[0]; /* past the last step: round to the first */
        for (unsigned k = 0; k < sizeof steps; k++)
            if (steps[k] > pct) { next = steps[k]; break; }
        set_brightness(next);
    } else if (i == R_LEVEL) {
        ui_level_set(!ui_level_on(), true);
    } else if (i == R_SOUNDS) {
        ui_sound_set(!ui_sound_on(), true);
        ui_sound(SFX_TAP); /* turned on: a chirp to hear it */
    }
    scr_settings_set();
    return rows[i].target;
}

scr_t scr_settings_top(void) { return activate(l.sel); }

scr_t scr_settings_tap(int32_t x, int32_t y)
{
    lv_obj_update_layout(l.root);
    for (int i = 0; i < N_ROWS; i++) {
        lv_area_t r;
        lv_obj_get_coords(l.row[i], &r);
        if (x < r.x1 || x > r.x2 || y < r.y1 || y > r.y2 || !rows[i].on) continue;
        l.sel = i;
        if (i == R_BRIGHT && x >= r.x1 + BAR_X - 12 && x <= r.x1 + BAR_X + BAR_W + 12) { /* on the bar: the step under the finger */
            int k = (x - (r.x1 + BAR_X)) * (int)sizeof steps / BAR_W;
            set_brightness(steps[k < 0 ? 0 : k >= (int)sizeof steps ? (int)sizeof steps - 1 : k]);
            scr_settings_set();
            return SCR_SETTINGS;
        }
        return activate(i);
    }
    return SCR_SETTINGS;
}

lv_obj_t *scr_settings_create(lv_obj_t *parent)
{
    memset(&l, 0, sizeof l);
    l.drawn_sel = l.drawn_pct = -1;
    for (int i = 0; i < N_ROWS; i++) l.drawn_sw[i] = -1;
    l.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    l.arc = arc_create(l.root, &l.sel);
    l.head = ui_label(l.root, &inter_16, UI_COLOR_SUBTLE, 200, 1, LV_TEXT_ALIGN_CENTER);
    lv_obj_t *col[N_ROWS + 1] = { l.head };
    uint8_t gap[N_ROWS + 1] = { 0, 8 };
    for (int i = 0; i < N_ROWS; i++) {
        lv_obj_t *r = ui_plain(l.root, ROW_W, ROW_H);
        lv_obj_set_style_radius(r, 14, 0);
        lv_obj_set_style_bg_color(r, lv_color_hex(COLOR_ROW_SEL), 0);
        l.row[i] = r;
        l.name[i] = ui_label(r, &inter_20, rows[i].on ? UI_COLOR_TEXT : UI_COLOR_DIM, 150, 1, LV_TEXT_ALIGN_LEFT);
        lv_obj_set_pos(l.name[i], PAD, (ROW_H - lv_obj_get_height(l.name[i])) / 2);
        lv_label_set_text(l.name[i], rows[i].name);
        col[1 + i] = r;
        if (i) gap[1 + i] = 0;
    }
    l.val[R_BRIGHT] = ui_label(l.row[R_BRIGHT], &inter_16, UI_COLOR_SUBTLE, 44, 1, LV_TEXT_ALIGN_RIGHT);
    l.bar = ui_plain(l.row[R_BRIGHT], BAR_W, BAR_H);
    lv_obj_set_pos(l.bar, BAR_X, (ROW_H - BAR_H) / 2);
    lv_obj_set_style_radius(l.bar, BAR_H / 2, 0);
    lv_obj_set_style_bg_opa(l.bar, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(l.bar, lv_color_hex(COLOR_BAR_TRACK), 0);
    lv_obj_set_style_clip_corner(l.bar, true, 0);
    l.fill = ui_plain(l.bar, BAR_W, BAR_H);
    lv_obj_set_style_bg_opa(l.fill, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(l.fill, lv_color_hex(UI_COLOR_ACCENT), 0);
    lv_obj_set_style_radius(l.fill, BAR_H / 2, 0);
    for (int i = 0; i < N_ROWS; i++) { /* the right-hand value of the rows that have a text one */
        if (i == R_BRIGHT || i == R_LEVEL || i == R_SOUNDS) continue;
        l.val[i] = ui_label(l.row[i], &inter_16, rows[i].on ? UI_COLOR_SUBTLE : UI_COLOR_DIM, 150, 1, LV_TEXT_ALIGN_RIGHT);
        lv_obj_set_pos(l.val[i], ROW_W - PAD - 150, (ROW_H - lv_obj_get_height(l.val[i])) / 2);
        if (!rows[i].on) lv_label_set_text(l.val[i], "Soon");
    }
    lv_obj_set_pos(l.val[R_BRIGHT], ROW_W - PAD - 44, (ROW_H - lv_obj_get_height(l.val[R_BRIGHT])) / 2);
    for (int i = R_SOUNDS; i <= R_LEVEL; i++) { /* the two switch rows, next to each other */
        l.sw[i] = ui_plain(l.row[i], SW_W, SW_H);
        lv_obj_set_pos(l.sw[i], ROW_W - PAD - SW_W, (ROW_H - SW_H) / 2);
        lv_obj_set_style_radius(l.sw[i], SW_H / 2, 0);
        lv_obj_set_style_bg_opa(l.sw[i], LV_OPA_COVER, 0);
        l.knob[i] = ui_plain(l.sw[i], KNOB, KNOB);
        lv_obj_set_y(l.knob[i], 3);
        lv_obj_set_style_radius(l.knob[i], LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_opa(l.knob[i], LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(l.knob[i], lv_color_hex(0xFFFFFF), 0);
    }
    ui_stack(col, gap, N_ROWS + 1, 0, UI_SCREEN_SIZE, -1);
    scr_settings_set();
    return l.root;
}

/* ---- Wi-Fi: the saved networks ---- */

void scr_wifinets_set(void)
{
    static const ui_wifi_names_t none; /* before the first publish, or when the buffer could not be allocated */
    const ui_wifi_names_t *n = ui_wifi_tb.slot[0] ? tribuf_latest(&ui_wifi_tb, NULL) : &none;
    char t[40];
    const char *state = wifi_state == UI_WIFI_CONNECTING ? " \xC2\xB7 CONNECTING" : wifi_state == UI_WIFI_BAD_PASSWORD ? " \xC2\xB7 WRONG PASSWORD" :
                        wifi_state == UI_WIFI_OFFLINE ? " \xC2\xB7 OFFLINE" : "";
    snprintf(t, sizeof t, "WI-FI%s", state);
    ui_set_text(w.head, t);
    ui_text_color(w.head, wifi_state == UI_WIFI_BAD_PASSWORD ? UI_COLOR_DANGER : UI_COLOR_SUBTLE);
    int count = n->n > WIFI_MAX ? WIFI_MAX : n->n;
    lv_obj_t *col[WIFI_MAX + 2] = { w.head };
    uint8_t gap[WIFI_MAX + 2] = { 0, 8 };
    int k = 1;
    for (int i = 0; i < WIFI_MAX; i++) {
        bool on = i < count;
        lv_obj_set_hidden(w.row[i], !on);
        if (!on) continue;
        bool cur = wifi_state == UI_WIFI_ONLINE && wifi_cur[0] && !strcmp(n->ssid[i], wifi_cur);
        snprintf(t, sizeof t, "%d", i + 1);
        ui_set_text(w.num[i], t);
        char ssid[33];
        snprintf(ssid, sizeof ssid, "%s", n->ssid[i]); /* the buffer is written by another task: the name is NUL-terminated by the producer, this is a copy */
        ui_set_text(w.name[i], ssid);
        ui_set_text(w.stat[i], cur ? "Connected" : "Saved");
        ui_text_color(w.stat[i], cur ? COLOR_OK : UI_COLOR_SUBTLE);
        col[k] = w.row[i];
        gap[k++] = i ? 0 : 8;
    }
    ui_set_text(w.foot, count ? "Add networks in Aelys" : "No saved networks");
    col[k] = w.foot;
    gap[k++] = 8;
    ui_stack(col, gap, k, 0, UI_SCREEN_SIZE, -1);
}

lv_obj_t *scr_wifinets_create(lv_obj_t *parent)
{
    static int top; /* the arc has nothing to scroll: the thumb stays at the start */
    memset(&w, 0, sizeof w);
    w.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    w.arc = arc_create(w.root, &top);
    w.head = ui_label(w.root, &inter_16, UI_COLOR_SUBTLE, 260, 1, LV_TEXT_ALIGN_CENTER);
    for (int i = 0; i < WIFI_MAX; i++) {
        lv_obj_t *r = ui_plain(w.root, ROW_W - 10, NET_H);
        w.row[i] = r;
        w.num[i] = ui_label(r, &inter_16, UI_COLOR_SUBTLE, NUM_D, 1, LV_TEXT_ALIGN_CENTER);
        lv_obj_set_style_bg_opa(w.num[i], LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(w.num[i], lv_color_hex(0x16141C), 0);
        lv_obj_set_style_radius(w.num[i], LV_RADIUS_CIRCLE, 0);
        lv_obj_set_height(w.num[i], NUM_D);
        lv_obj_set_style_pad_top(w.num[i], (NUM_D - lv_font_get_line_height(&inter_16)) / 2, 0);
        lv_obj_set_pos(w.num[i], 0, (NET_H - NUM_D) / 2);
        w.name[i] = ui_label(r, &inter_20, UI_COLOR_TEXT, ROW_W - 10 - NUM_D - 12, 1, LV_TEXT_ALIGN_LEFT);
        lv_obj_set_pos(w.name[i], NUM_D + 12, 7);
        w.stat[i] = ui_label(r, &inter_16, UI_COLOR_SUBTLE, ROW_W - 10 - NUM_D - 12, 1, LV_TEXT_ALIGN_LEFT);
        lv_obj_set_pos(w.stat[i], NUM_D + 12, 7 + lv_font_get_line_height(&inter_20) + 2);
    }
    w.foot = ui_label(w.root, &inter_16, UI_COLOR_MUTED, 260, 1, LV_TEXT_ALIGN_CENTER);
    scr_wifinets_set();
    return w.root;
}

/* ---- About ---- */

void scr_about_set(void)
{
    static const char *const names[3] = { "Firmware", "Battery", "Pairing" };
    uint32_t now = lv_tick_get();
    if (hooks && (!a.battery[0] || now - a.read_ms >= 5000)) { /* the PMIC is read at most every 5 s, and only while this screen shows */
        uint8_t b = 0;
        bool charging = false;
        a.read_ms = now;
        if (hooks->battery && hooks->battery(&b, &charging)) snprintf(a.battery, sizeof a.battery, "%d%%%s", b > 100 ? 100 : b, charging ? " \xC2\xB7 charging" : "");
        else snprintf(a.battery, sizeof a.battery, "No battery");
    }
    ui_set_text(a.head, "ABOUT");
    const char *v[3] = { hooks && hooks->version ? hooks->version() : "", a.battery[0] ? a.battery : "--", ui_paired() ? "Paired" : "Not paired" };
    for (int i = 0; i < 3; i++) {
        ui_set_text(a.name[i], names[i]);
        ui_set_text(a.val[i], v[i]);
    }
}

lv_obj_t *scr_about_create(lv_obj_t *parent)
{
    memset(&a, 0, sizeof a);
    a.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    a.head = ui_label(a.root, &inter_16, UI_COLOR_SUBTLE, 200, 1, LV_TEXT_ALIGN_CENTER);
    lv_obj_t *col[4] = { a.head };
    uint8_t gap[4] = { 0, 8, 0, 0 };
    for (int i = 0; i < 3; i++) {
        a.row[i] = ui_plain(a.root, ROW_W, ROW_H);
        a.name[i] = ui_label(a.row[i], &inter_20, UI_COLOR_TEXT, 120, 1, LV_TEXT_ALIGN_LEFT);
        lv_obj_set_pos(a.name[i], PAD, (ROW_H - lv_obj_get_height(a.name[i])) / 2);
        a.val[i] = ui_label(a.row[i], &inter_20, UI_COLOR_SUBTLE, 170, 1, LV_TEXT_ALIGN_RIGHT);
        lv_obj_set_pos(a.val[i], ROW_W - PAD - 170, (ROW_H - lv_obj_get_height(a.val[i])) / 2);
        col[1 + i] = a.row[i];
    }
    ui_stack(col, gap, 4, 0, UI_SCREEN_SIZE, -1);
    scr_about_set();
    return a.root;
}
