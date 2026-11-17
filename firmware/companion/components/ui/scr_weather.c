/* Weather (design "Погода · сейчас" and "Погода · по часам"), from the snapshot's `weather` (server v1.3, "feels" v1.4). Two views:
 * Now: the condition glyph, the big temperature, the condition in words and "Feels -7° · H -1° L -8°". Hours ("Next hours"): Now and
 * the next four city-local hours (glyph, temperature) with a highlight a swipe moves, and "Snow until 18:00" when the hours tell. The
 * top key switches the views (its word says which comes next). Without weather - no city set in the app, no forecast yet, an older
 * server - "No weather yet / Set a city in the app". Once the forecast is over 2 hours old its hours are past: only Now, with
 * "Updated HH:MM". render() runs once a second for the visible screen; nothing redraws unless the weather, the view or the stale
 * state changed.
 * Deviations: no snow falling on the screen; the big temperature draws its own minus bar and degree ring (the clock font has
 * digits only); without "feels" from the server the line is just "H -1° L -8°". */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ui_screens_priv.h"
#include "ui_weather_icons.h"

#define COLOR_WEATHER 0x7FA8F5
#define STALE_S (2 * 3600)
#define COL_W 64   /* the design's 60 px columns 4 px apart */
#define COL_H 100
#define PILL_W 60
#define PILL_H 124
#define N_COLS 5   /* Now and the next four hours */
#define DIGIT_H 70 /* height of a digit of inter_clock_96 (cap height) */
#define MINUS_W 28
#define MINUS_H 7
#define RING_D 20
#define RING_W 5
#define SIDE_GAP 8

typedef enum { WV_NOW, WV_HOURS } wview_t;

static struct {
    lv_obj_t *root, *eb, *icon_box, *icon, *temp, *digits, *minus, *ring, *desc, *hl, *hours, *pill, *foot, *key, *e_title, *e_hint;
    struct { lv_obj_t *col, *hour, *icon, *temp; } c[N_COLS];
    snap_weather_t shown;
    bool have_shown, shown_stale;
    wview_t view, shown_view;
    int sel, shown_sel, n_cols;
} w;

typedef struct { wx_icon_t icon; const char *text; } wx_t;

/* WMO weather interpretation codes (Open-Meteo): https://open-meteo.com/en/docs */
static wx_t wx_of(uint8_t code)
{
    switch (code) {
    case 0: return (wx_t){ WX_SUN, "Clear sky" };
    case 1: return (wx_t){ WX_SUN, "Mostly clear" };
    case 2: return (wx_t){ WX_CLOUD_SUN, "Partly cloudy" };
    case 3: return (wx_t){ WX_CLOUD, "Overcast" };
    case 45: case 48: return (wx_t){ WX_FOG, "Fog" };
    case 51: case 53: case 55: return (wx_t){ WX_RAIN, "Drizzle" };
    case 56: case 57: return (wx_t){ WX_RAIN, "Freezing drizzle" };
    case 61: return (wx_t){ WX_RAIN, "Light rain" };
    case 63: return (wx_t){ WX_RAIN, "Rain" };
    case 65: return (wx_t){ WX_RAIN, "Heavy rain" };
    case 66: case 67: return (wx_t){ WX_RAIN, "Freezing rain" };
    case 71: return (wx_t){ WX_SNOW, "Light snow" };
    case 73: return (wx_t){ WX_SNOW, "Snow" };
    case 75: return (wx_t){ WX_SNOW, "Heavy snow" };
    case 77: return (wx_t){ WX_SNOW, "Snow grains" };
    case 80: case 81: return (wx_t){ WX_RAIN, "Rain showers" };
    case 82: return (wx_t){ WX_RAIN, "Heavy showers" };
    case 85: case 86: return (wx_t){ WX_SNOW, "Snow showers" };
    case 95: return (wx_t){ WX_STORM, "Thunderstorm" };
    case 96: case 99: return (wx_t){ WX_STORM, "Storm with hail" };
    default: return (wx_t){ WX_CLOUD, "Cloudy" };
    }
}

static bool is_stale(const snap_weather_t *x, int64_t now) { return now > 0 && now - x->updated > STALE_S; }

void scr_weather_summary(const snap_t *s, char *out, size_t cap)
{
    out[0] = 0;
    if (s->weather.present) snprintf(out, cap, "%d C \xC2\xB7 %s", s->weather.temp, wx_of(s->weather.code).text);
}

static void set_icon(lv_obj_t *img, const lv_image_dsc_t *src, uint32_t color)
{
    if (lv_image_get_src(img) != src) lv_image_set_src(img, src);
    lv_obj_set_style_image_recolor(img, lv_color_hex(color), 0);
}

/* "-3" as the design's big number: digits in the clock font, a bar for the minus and a ring for the degree, centred as one group. */
static void set_temp(int temp)
{
    char d[8];
    lv_point_t sz;
    snprintf(d, sizeof d, "%d", abs(temp));
    ui_set_text(w.digits, d);
    lv_text_get_size(&sz, d, &inter_clock_96, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    bool neg = temp < 0;
    int32_t total = (neg ? MINUS_W + SIDE_GAP : 0) + sz.x + SIDE_GAP + RING_D;
    int32_t x = (lv_obj_get_width(w.temp) - total) / 2;
    int32_t top = lv_font_get_line_height(&inter_clock_96) - inter_clock_96.base_line - DIGIT_H; /* digit top inside the label's line */
    lv_obj_set_hidden(w.minus, !neg);
    if (neg) { lv_obj_set_pos(w.minus, x, 4 + DIGIT_H / 2 - MINUS_H / 2); x += MINUS_W + SIDE_GAP; }
    lv_obj_set_width(w.digits, sz.x + 8);
    lv_obj_set_pos(w.digits, x, 4 - top);
    lv_obj_set_pos(w.ring, x + sz.x + SIDE_GAP, 4 + 4);
}

/* "−4°" with the true minus the text fonts carry */
static void fmt_deg(char *out, size_t cap, int t)
{
    snprintf(out, cap, "%s%d\xC2\xB0", t < 0 ? "\xE2\x88\x92" : "", abs(t));
}

/* 0 dry, 1 rain, 2 snow, 3 storm: what "until" and "from" speak of */
static int wet(uint8_t code)
{
    if (code >= 95) return 3;
    if ((code >= 71 && code <= 77) || code == 85 || code == 86) return 2;
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 1;
    return 0;
}

/* "Snow until 18:00" while it snows and a later hour is dry; "Rain from 17:00" when it starts within the hours; else "". */
static void wet_line(const snap_weather_t *x, char *out, size_t cap)
{
    static const char *const name[] = { "", "Rain", "Snow", "Storm" };
    int now = wet(x->code);
    out[0] = 0;
    for (int i = 0; i < x->n_hours; i++) {
        int k = wet(x->hours[i].code);
        if (now && k != now) { snprintf(out, cap, "%s until %02d:00", name[now], x->hours[i].hour); return; }
        if (!now && k) { snprintf(out, cap, "%s from %02d:00", name[k], x->hours[i].hour); return; }
    }
}

static void stack(lv_obj_t **col, const uint8_t *gap, int n)
{
    ui_stack(col, gap, n, 0, UI_SCREEN_SIZE, -1);
}

static void show_now(const snap_weather_t *x, bool stale)
{
    wx_t cur = wx_of(x->code);
    set_icon(w.icon, &weather_icon_big[cur.icon], COLOR_WEATHER);
    set_temp(x->temp);
    ui_set_text(w.desc, cur.text);
    char t[64], a[12], b[12], c[12]; /* "Feels −99° · H −99° L −99°" is 31 bytes; the compiler counts each part at its 11 */
    fmt_deg(b, sizeof b, x->hi);
    fmt_deg(c, sizeof c, x->lo);
    if (x->has_feels) { fmt_deg(a, sizeof a, x->feels); snprintf(t, sizeof t, "Feels %s \xC2\xB7 H %s L %s", a, b, c); }
    else snprintf(t, sizeof t, "H %s L %s", b, c);
    ui_set_text(w.hl, t);
    char hm[8];
    ui_fmt_hm(hm, x->updated);
    snprintf(t, sizeof t, "Updated %s", hm);
    ui_set_text(w.eb, t);
    ui_text_color(w.eb, UI_COLOR_SUBTLE);
    lv_obj_t *col[5];
    uint8_t gap[5];
    int n = 0;
    if (stale) { col[n] = w.eb; gap[n++] = 0; }
    col[n] = w.icon_box; gap[n] = n ? 8 : 0; n++;
    col[n] = w.temp; gap[n++] = 10;
    col[n] = w.desc; gap[n++] = 4;
    col[n] = w.hl; gap[n++] = 8;
    lv_obj_set_hidden(w.eb, !stale);
    stack(col, gap, n);
}

static void show_hours(const snap_weather_t *x)
{
    char t[24];
    for (int i = 0; i < N_COLS; i++) {
        lv_obj_set_hidden(w.c[i].col, i >= w.n_cols);
        if (i >= w.n_cols) continue;
        uint8_t code = i ? x->hours[i - 1].code : x->code;
        int temp = i ? x->hours[i - 1].temp : x->temp;
        if (i) snprintf(t, sizeof t, "%d", x->hours[i - 1].hour);
        ui_set_text(w.c[i].hour, i ? t : "Now");
        set_icon(w.c[i].icon, &weather_icon_small[wx_of(code).icon], UI_COLOR_TEXT2);
        fmt_deg(t, sizeof t, temp);
        ui_set_text(w.c[i].temp, t);
        lv_obj_set_pos(w.c[i].col, (lv_obj_get_width(w.hours) - w.n_cols * COL_W) / 2 + i * COL_W, 0);
    }
    lv_obj_set_pos(w.pill, (lv_obj_get_width(w.hours) - w.n_cols * COL_W) / 2 + w.sel * COL_W + (COL_W - PILL_W) / 2, 0);
    ui_set_text(w.eb, "NEXT HOURS");
    lv_obj_set_hidden(w.eb, false);
    ui_text_color(w.eb, UI_COLOR_SUBTLE);
    wet_line(x, t, sizeof t);
    ui_set_text(w.foot, t);
    lv_obj_set_hidden(w.foot, !t[0]);
    lv_obj_t *col[3] = { w.eb, w.hours, w.foot };
    const uint8_t gap[3] = { 0, 18, 18 };
    stack(col, gap, t[0] ? 3 : 2);
}

/* x may be w.shown itself (a key or a swipe redraws the same data) */
static void apply(const snap_weather_t *x, bool stale)
{
    int n_cols = x->present && !stale ? 1 + (x->n_hours < N_COLS - 1 ? x->n_hours : N_COLS - 1) : 0;
    if (n_cols < 2) w.view = WV_NOW; /* nothing ahead to show: the hours are past or there are none */
    if (w.sel >= n_cols) w.sel = n_cols ? n_cols - 1 : 0;
    if (w.have_shown && w.shown_stale == stale && w.shown_view == w.view && w.shown_sel == w.sel && !memcmp(&w.shown, x, sizeof *x)) return;
    if (x != &w.shown) w.shown = *x;
    w.shown_stale = stale;
    w.shown_view = w.view;
    w.shown_sel = w.sel;
    w.have_shown = true;
    w.n_cols = n_cols;

    bool empty = !x->present, hours = !empty && w.view == WV_HOURS;
    lv_obj_set_hidden(w.e_title, !empty);
    lv_obj_set_hidden(w.e_hint, !empty);
    lv_obj_set_hidden(w.icon_box, hours);
    lv_obj_set_hidden(w.temp, empty || hours);
    lv_obj_set_hidden(w.desc, empty || hours);
    lv_obj_set_hidden(w.hl, empty || hours);
    lv_obj_set_hidden(w.hours, !hours);
    lv_obj_set_hidden(w.foot, !hours);
    ui_set_text(w.key, hours ? "Now" : "Hours");
    lv_obj_set_hidden(w.key, n_cols < 2);
    if (empty) {
        set_icon(w.icon, &weather_icon_big[WX_CLOUD_SUN], UI_COLOR_DIM);
        lv_obj_set_hidden(w.eb, true);
        lv_obj_t *col[3] = { w.icon_box, w.e_title, w.e_hint };
        const uint8_t gap[3] = { 0, 14, 6 };
        stack(col, gap, 3);
        return;
    }
    if (hours) show_hours(x);
    else show_now(x, stale);
}

void scr_weather_set(const snap_t *s, int64_t now)
{
    apply(&s->weather, s->weather.present && is_stale(&s->weather, now));
}

void scr_weather_top(void)
{
    if (w.n_cols < 2) return;
    w.view = w.view == WV_NOW ? WV_HOURS : WV_NOW;
    w.sel = 0;
    apply(&w.shown, w.shown_stale);
}

void scr_weather_swipe(int dir)
{
    if (w.view != WV_HOURS) return;
    int s = w.sel + dir;
    if (s < 0 || s >= w.n_cols) return;
    w.sel = s;
    apply(&w.shown, w.shown_stale);
}

void scr_weather_open(void) { w.view = WV_NOW; w.sel = 0; }

lv_obj_t *scr_weather_create(lv_obj_t *parent)
{
    memset(&w, 0, sizeof w);
    w.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    w.eb = ui_label(w.root, &inter_16, UI_COLOR_SUBTLE, 260, 1, LV_TEXT_ALIGN_CENTER);
    lv_obj_set_style_text_letter_space(w.eb, 1, 0); /* the design's tracked eyebrow */
    w.icon_box = ui_plain(w.root, 48, 48);
    w.icon = lv_image_create(w.icon_box);
    lv_obj_set_clickable(w.icon, false);
    lv_image_set_src(w.icon, &weather_icon_big[WX_CLOUD_SUN]);
    lv_obj_set_style_image_recolor_opa(w.icon, LV_OPA_COVER, 0);
    lv_obj_center(w.icon);
    w.temp = ui_plain(w.root, 300, DIGIT_H + 8);
    w.digits = ui_label(w.temp, &inter_clock_96, UI_COLOR_TEXT, 120, 1, LV_TEXT_ALIGN_LEFT);
    w.minus = ui_plain(w.temp, MINUS_W, MINUS_H);
    lv_obj_set_style_bg_opa(w.minus, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(w.minus, lv_color_hex(UI_COLOR_TEXT), 0);
    lv_obj_set_style_radius(w.minus, MINUS_H / 2, 0);
    w.ring = ui_plain(w.temp, RING_D, RING_D);
    lv_obj_set_style_radius(w.ring, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(w.ring, RING_W, 0);
    lv_obj_set_style_border_color(w.ring, lv_color_hex(UI_COLOR_TEXT), 0);
    w.desc = ui_label(w.root, &inter_20, UI_COLOR_TEXT2, 300, 1, LV_TEXT_ALIGN_CENTER);
    w.hl = ui_label(w.root, &inter_16, UI_COLOR_SUBTLE, 320, 1, LV_TEXT_ALIGN_CENTER);
    w.hours = ui_plain(w.root, N_COLS * COL_W, PILL_H);
    w.pill = ui_plain(w.hours, PILL_W, PILL_H);
    lv_obj_set_style_bg_opa(w.pill, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(w.pill, lv_color_hex(0x1A1824), 0);
    lv_obj_set_style_radius(w.pill, PILL_W / 2, 0);
    for (int i = 0; i < N_COLS; i++) {
        w.c[i].col = ui_plain(w.hours, COL_W, PILL_H);
        w.c[i].hour = ui_label(w.c[i].col, &inter_16, UI_COLOR_SUBTLE, COL_W, 1, LV_TEXT_ALIGN_CENTER);
        lv_obj_set_pos(w.c[i].hour, 0, 14);
        w.c[i].icon = lv_image_create(w.c[i].col);
        lv_obj_set_clickable(w.c[i].icon, false);
        lv_image_set_src(w.c[i].icon, &weather_icon_small[WX_CLOUD]);
        lv_obj_set_style_image_recolor_opa(w.c[i].icon, LV_OPA_COVER, 0);
        lv_obj_set_pos(w.c[i].icon, (COL_W - 24) / 2, 46);
        w.c[i].temp = ui_label(w.c[i].col, &inter_20, UI_COLOR_TEXT, COL_W, 1, LV_TEXT_ALIGN_CENTER);
        lv_obj_set_pos(w.c[i].temp, 0, 80);
        lv_obj_set_hidden(w.c[i].col, true);
    }
    w.foot = ui_label(w.root, &inter_16, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    w.key = ui_label(w.root, &inter_16, UI_COLOR_ACCENT, 90, 1, LV_TEXT_ALIGN_RIGHT);
    ui_key_hint_place(w.key, false);
    w.e_title = ui_label(w.root, &inter_28, UI_COLOR_TEXT, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(w.e_title, "No weather yet");
    w.e_hint = ui_label(w.root, &inter_20, UI_COLOR_SUBTLE, 280, 2, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(w.e_hint, "Set a city in the app");
    scr_weather_set(&ui_empty_snap, 0);
    return w.root;
}
