/* Screen switching: home, lost mode, the ICE card and the pairing screen are full-size objects on the one
 * active LVGL screen, shown and hidden by screen_next(); one more overlay shows the both-buttons progress. */
#include <string.h>
#include "ui_screens_priv.h"

#define ICE_TIMEOUT_MS 15000
#define PAIRED_SHOW_MS 2000

tribuf_t ui_owner_tb;
static owner_info_t owner_buf[3];

static struct {
    scr_t cur;
    bool lost;
    lv_obj_t *scr[SCR_COUNT]; /* indexed by scr_t; NULL for screens that do not exist yet */
    lv_timer_t *ice_timer, *paired_timer;
} g;

lv_obj_t *ui_plain(lv_obj_t *parent, int32_t w, int32_t h)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_set_clickable(o, false);
    lv_obj_set_scrollable(o, false);
    lv_obj_set_style_bg_opa(o, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(o, 0, 0);
    lv_obj_set_style_pad_all(o, 0, 0);
    lv_obj_set_style_radius(o, 0, 0);
    lv_obj_set_size(o, w, h);
    lv_obj_update_layout(o); /* lv_obj_get_width/height read the real size only after this */
    return o;
}

lv_obj_t *ui_ring(lv_obj_t *parent, int32_t inset, int32_t width, uint32_t color)
{
    lv_obj_t *o = ui_plain(parent, UI_SCREEN_SIZE - 2 * inset, UI_SCREEN_SIZE - 2 * inset);
    lv_obj_set_pos(o, inset, inset);
    lv_obj_set_style_radius(o, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(o, width, 0);
    lv_obj_set_style_border_color(o, lv_color_hex(color), 0);
    return o;
}

lv_obj_t *ui_label(lv_obj_t *parent, const lv_font_t *font, uint32_t color, int32_t w, int32_t lines,
                   lv_text_align_t align)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_label_set_long_mode(l, LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_obj_set_style_text_align(l, align, 0);
    lv_obj_set_size(l, w, lines * lv_font_get_line_height(font));
    lv_obj_update_layout(l);
    return l;
}

int32_t ui_text_height(const char *txt, const lv_font_t *font, int32_t w, int32_t max_lines)
{
    lv_point_t sz;
    int32_t lh = lv_font_get_line_height(font);
    lv_text_get_size(&sz, txt, font, 0, 0, w, LV_TEXT_FLAG_NONE);
    if (sz.y < lh) sz.y = lh;
    return sz.y > max_lines * lh ? max_lines * lh : sz.y;
}

void ui_stack(lv_obj_t *const o[], const uint8_t gap[], int n, int32_t area_y, int32_t area_h, int32_t x)
{
    int32_t total = 0;
    bool first = true;
    lv_obj_update_layout(lv_obj_get_parent(o[0]));
    for (int i = 0; i < n; i++) {
        if (lv_obj_is_hidden(o[i])) continue;
        total += lv_obj_get_height(o[i]) + (first ? 0 : gap[i]);
        first = false;
    }
    int32_t y = area_y + (area_h - total) / 2;
    first = true;
    for (int i = 0; i < n; i++) {
        if (lv_obj_is_hidden(o[i])) continue;
        if (!first) y += gap[i];
        first = false;
        lv_obj_set_pos(o[i], x < 0 ? (lv_obj_get_width(lv_obj_get_parent(o[i])) - lv_obj_get_width(o[i])) / 2 : x, y);
        y += lv_obj_get_height(o[i]);
    }
}

scr_t ui_current_screen(void) { return g.cur; }

static void ice_timeout(lv_timer_t *t)
{
    (void)t;
    g.ice_timer = NULL; /* one-shot: LVGL deletes it after this call */
    ui_event_t ev = { .type = UI_EV_TOUCH };
    ui_handle_event(&ev); /* a tap on the card: back to home or lost mode */
}

static void show(scr_t s);

static void paired_timeout(lv_timer_t *t)
{
    (void)t;
    g.paired_timer = NULL; /* one-shot */
    scr_t next = screen_next_pair(g.cur, g.lost, PAIR_UI_DONE);
    if (next != g.cur) show(next);
}

static void show(scr_t s)
{
    for (int i = 0; i < SCR_COUNT; i++)
        if (g.scr[i]) lv_obj_set_hidden(g.scr[i], i != (int)s);
    g.cur = s;
    scr_hold_set(0);
    if (s == SCR_ICE) {
        if (g.ice_timer) {
            lv_timer_reset(g.ice_timer);
        } else {
            g.ice_timer = lv_timer_create(ice_timeout, ICE_TIMEOUT_MS, NULL);
            lv_timer_set_repeat_count(g.ice_timer, 1);
        }
    } else if (g.ice_timer) {
        lv_timer_delete(g.ice_timer);
        g.ice_timer = NULL;
    }
    if (s != SCR_PAIR && g.paired_timer) {
        lv_timer_delete(g.paired_timer);
        g.paired_timer = NULL;
    }
}

static void set_owner(const owner_info_t *o)
{
    scr_lost_set_owner(o);
    scr_ice_set_owner(o);
}

void ui_setup(void)
{
    lv_obj_t *root = lv_screen_active();
    ui_theme_apply(root);
    g.scr[SCR_HOME] = scr_home_create(root);
    g.scr[SCR_LOST] = scr_lost_create(root);
    g.scr[SCR_ICE] = scr_ice_create(root);
    g.scr[SCR_PAIR] = scr_pair_create(root);
    scr_hold_create(root);
    for (int i = 0; i < 3; i++) owner_defaults(&owner_buf[i]);
    tribuf_init(&ui_owner_tb, &owner_buf[0], &owner_buf[1], &owner_buf[2]);
    set_owner(tribuf_latest(&ui_owner_tb, NULL));
    g.lost = false;
    show(SCR_HOME);
}

void ui_handle_event(const ui_event_t *ev)
{
    scr_t next = g.cur;
    switch (ev->type) {
    case UI_EV_TIME:
        if (ev->len >= 2) scr_home_set_time(ev->data[0], ev->data[1]);
        return;
    case UI_EV_WIFI:
        if (ev->len >= 1) scr_home_set_wifi(ev->data[0]);
        return;
    case UI_EV_OWNER: {
        bool fresh;
        const owner_info_t *o = tribuf_latest(&ui_owner_tb, &fresh);
        if (fresh) set_owner(o);
        return;
    }
    case UI_EV_LINK:
        if (ev->len >= 1) scr_home_set_welcome(ev->data[0] == LINK_UI_UNPAIRED);
        return;
    case UI_EV_PAIR: {
        if (ev->len < 1) return;
        ui_pair_t what = (ui_pair_t)ev->data[0];
        if (what == PAIR_UI_CODE) {
            if (ev->len < 7 || screen_next_pair(g.cur, g.lost, what) != SCR_PAIR || !scr_pair_set_code((const char *)&ev->data[1]))
                return;
            if (g.paired_timer) { lv_timer_delete(g.paired_timer); g.paired_timer = NULL; } /* a new code replaces the card */
            next = SCR_PAIR;
        } else if (what == PAIR_UI_DONE) {
            scr_home_set_welcome(false); /* paired: the first-boot welcome is over, whatever screen is up */
            if (screen_next_pair(g.cur, g.lost, PAIR_UI_CODE) != SCR_PAIR) return; /* lost mode / ICE card: no card */
            scr_pair_set_done();
            if (g.paired_timer) lv_timer_reset(g.paired_timer);
            else {
                g.paired_timer = lv_timer_create(paired_timeout, PAIRED_SHOW_MS, NULL);
                lv_timer_set_repeat_count(g.paired_timer, 1);
            }
            next = SCR_PAIR;
        } else if (what == PAIR_UI_HIDE) {
            next = screen_next_pair(g.cur, g.lost, what);
        } else {
            return;
        }
        break;
    }
    case UI_EV_COMBO_PROGRESS:
        /* the overlay is for opening the card: not while it is already open */
        scr_hold_set(g.cur == SCR_ICE || ev->len < 1 ? 0 : ev->data[0]);
        return;
    case UI_EV_LOST:
        if (ev->len < 1) return;
        g.lost = ev->data[0] != 0;
        if (g.cur == SCR_ICE) return; /* the card stays open; dismissing it picks the right screen */
        next = screen_next(g.cur, g.lost, UI_EV_LOST);
        break;
    default:
        next = screen_next(g.cur, g.lost, (ui_event_type_t)ev->type);
        break;
    }
    if (next != g.cur || ev->type == UI_EV_COMBO_FIRE) show(next);
}
