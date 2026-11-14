/* Weather (design "Погода · сейчас и по часам"): the condition glyph, the big temperature, the condition in words, today's high and low,
 * and a row of the next hours (city-local hour, glyph, temperature), all from the snapshot's `weather` (server v1.3). Without it - no
 * city set in the app, no forecast yet, an older server - "No weather yet / Set a city in the app". Once the forecast is over 2 hours
 * old the hour row is dropped (its hours are past) and "Updated HH:MM" says how old the numbers are.
 * render() runs once a second for the visible screen; nothing redraws unless the weather or the stale state changed.
 * Deviations: one screen instead of the design's two (now, then hours); no "feels like" (the snapshot has none); the fonts have no
 * degree sign or true minus, so the big temperature draws its own ring and bar, and the small ones are bare numbers; no snow animation. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ui_screens_priv.h"
#include "ui_weather_icons.h"

#define COLOR_WEATHER 0x7FA8F5
#define STALE_S (2 * 3600)
#define COL_W 62
#define COL_H 82
#define DIGIT_H 70 /* height of a digit of inter_clock_96 (cap height) */
#define MINUS_W 28
#define MINUS_H 7
#define RING_D 20
#define RING_W 5
#define SIDE_GAP 8

static struct {
    lv_obj_t *root, *eb, *icon_box, *icon, *temp, *digits, *minus, *ring, *desc, *hl, *hours, *e_title, *e_hint;
    struct { lv_obj_t *col, *hour, *icon, *temp; } c[SNAP_MAX_HOURS];
    snap_weather_t shown;
    bool have_shown, shown_stale;
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

static void layout(bool empty, bool stale, int n_hours)
{
    lv_obj_t *col[7];
    uint8_t gap[7];
    int n = 0;
    if (empty) {
        col[n] = w.icon_box; gap[n++] = 0;
        col[n] = w.e_title; gap[n++] = 14;
        col[n] = w.e_hint; gap[n++] = 6;
    } else {
        col[n] = w.eb; gap[n++] = 0;
        col[n] = w.icon_box; gap[n++] = 4;
        col[n] = w.temp; gap[n++] = 2;
        col[n] = w.desc; gap[n++] = 4;
        col[n] = w.hl; gap[n++] = 2;
        col[n] = w.hours; gap[n++] = 12;
    }
    (void)stale; (void)n_hours;
    ui_stack(col, gap, n, 0, UI_SCREEN_SIZE, -1);
}

void scr_weather_set(const snap_t *s, int64_t now)
{
    const snap_weather_t *x = &s->weather;
    bool stale = x->present && is_stale(x, now);
    if (w.have_shown && w.shown_stale == stale && !memcmp(&w.shown, x, sizeof *x)) return;
    w.shown = *x;
    w.shown_stale = stale;
    w.have_shown = true;

    bool empty = !x->present;
    lv_obj_set_hidden(w.e_title, !empty);
    lv_obj_set_hidden(w.e_hint, !empty);
    lv_obj_set_hidden(w.temp, empty);
    lv_obj_set_hidden(w.desc, empty);
    lv_obj_set_hidden(w.hl, empty);
    if (empty) {
        set_icon(w.icon, &weather_icon_big[WX_CLOUD_SUN], UI_COLOR_DIM);
        lv_obj_set_hidden(w.eb, true);
        lv_obj_set_hidden(w.hours, true);
        layout(true, false, 0);
        return;
    }
    wx_t cur = wx_of(x->code);
    set_icon(w.icon, &weather_icon_big[cur.icon], COLOR_WEATHER);
    set_temp(x->temp);
    ui_set_text(w.desc, cur.text);
    char t[32];
    snprintf(t, sizeof t, "H %d  L %d", x->hi, x->lo);
    ui_set_text(w.hl, t);
    char hm[8];
    ui_fmt_hm(hm, x->updated);
    snprintf(t, sizeof t, "Updated %s", hm);
    ui_set_text(w.eb, t);
    lv_obj_set_hidden(w.eb, !stale);
    int n = stale ? 0 : x->n_hours;
    lv_obj_set_hidden(w.hours, n == 0);
    for (int i = 0; i < SNAP_MAX_HOURS; i++) {
        lv_obj_set_hidden(w.c[i].col, i >= n);
        if (i >= n) continue;
        const snap_hour_t *h = &x->hours[i];
        snprintf(t, sizeof t, "%02d:00", h->hour);
        ui_set_text(w.c[i].hour, t);
        set_icon(w.c[i].icon, &weather_icon_small[wx_of(h->code).icon], UI_COLOR_TEXT2);
        snprintf(t, sizeof t, "%d", h->temp);
        ui_set_text(w.c[i].temp, t);
        lv_obj_set_pos(w.c[i].col, (lv_obj_get_width(w.hours) - n * COL_W) / 2 + i * COL_W, 0);
    }
    layout(false, stale, n);
}

lv_obj_t *scr_weather_create(lv_obj_t *parent)
{
    memset(&w, 0, sizeof w);
    w.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    w.eb = ui_label(w.root, &inter_16, UI_COLOR_SUBTLE, 260, 1, LV_TEXT_ALIGN_CENTER);
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
    w.hl = ui_label(w.root, &inter_20, UI_COLOR_SUBTLE, 300, 1, LV_TEXT_ALIGN_CENTER);
    w.hours = ui_plain(w.root, SNAP_MAX_HOURS * COL_W, COL_H);
    for (int i = 0; i < SNAP_MAX_HOURS; i++) {
        w.c[i].col = ui_plain(w.hours, COL_W, COL_H);
        w.c[i].hour = ui_label(w.c[i].col, &inter_16, UI_COLOR_SUBTLE, COL_W, 1, LV_TEXT_ALIGN_CENTER);
        lv_obj_set_pos(w.c[i].hour, 0, 0);
        w.c[i].icon = lv_image_create(w.c[i].col);
        lv_obj_set_clickable(w.c[i].icon, false);
        lv_image_set_src(w.c[i].icon, &weather_icon_small[WX_CLOUD]);
        lv_obj_set_style_image_recolor_opa(w.c[i].icon, LV_OPA_COVER, 0);
        lv_obj_set_pos(w.c[i].icon, (COL_W - 24) / 2, 28);
        w.c[i].temp = ui_label(w.c[i].col, &inter_20, UI_COLOR_TEXT, COL_W, 1, LV_TEXT_ALIGN_CENTER);
        lv_obj_set_pos(w.c[i].temp, 0, 58);
        lv_obj_set_hidden(w.c[i].col, true);
    }
    w.e_title = ui_label(w.root, &inter_28, UI_COLOR_TEXT, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(w.e_title, "No weather yet");
    w.e_hint = ui_label(w.root, &inter_20, UI_COLOR_SUBTLE, 280, 2, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(w.e_hint, "Set a city in the app");
    scr_weather_set(&ui_empty_snap, 0);
    return w.root;
}
