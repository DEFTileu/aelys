#include "sim_display.h"
#include <string.h>
#include "ui.h"
#include "ui_theme.h"

static _Alignas(LV_DRAW_BUF_ALIGN) uint16_t g_fb[SIM_W * SIM_H];
static uint32_t g_ms, g_flushes;
static uint32_t g_pixels;
static bool g_partial;
static _Alignas(LV_DRAW_BUF_ALIGN) uint16_t g_draw[2][SIM_W * 32];

static uint32_t tick_cb(void) { return g_ms; }

static void flush_cb(lv_display_t *d, const lv_area_t *a, uint8_t *px)
{
    uint32_t width = (uint32_t)lv_area_get_width(a), height = (uint32_t)lv_area_get_height(a);
    g_pixels += width * height;
    if (g_partial) {
        uint32_t stride = lv_display_get_buf_active(d)->header.stride;
        for (uint32_t y = 0; y < height; y++)
            memcpy(g_fb + (a->y1 + y) * SIM_W + a->x1, px + y * stride, width * sizeof(uint16_t));
    }
    if (lv_display_flush_is_last(d)) g_flushes++;
    lv_display_flush_ready(d);
}

void sim_init(void)
{
    lv_init();
    lv_tick_set_cb(tick_cb);
    lv_display_t *d = lv_display_create(SIM_W, SIM_H);
    lv_display_set_color_format(d, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(d, g_fb, NULL, sizeof g_fb, LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_flush_cb(d, flush_cb);
    ui_theme_apply(lv_screen_active());
    sim_step(40);
}

void sim_direct(void)
{
    g_partial = false;
    lv_display_set_buffers(lv_display_get_default(), g_fb, NULL, sizeof g_fb, LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_obj_invalidate(lv_screen_active());
    sim_step(20);
}

static void round_area(lv_event_t *e)
{
    lv_area_t *a = lv_event_get_param(e);
    a->x1 &= ~1; a->y1 &= ~1; a->x2 |= 1; a->y2 |= 1;
}

void sim_partial(void)
{
    lv_display_t *d = lv_display_get_default();
    g_partial = true;
    lv_timer_set_period(lv_display_get_refr_timer(d), 5); /* firmware CONFIG_LV_DEF_REFR_PERIOD */
    lv_display_set_buffers(d, g_draw[0], g_draw[1], sizeof g_draw[0], LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_add_event_cb(d, round_area, LV_EVENT_INVALIDATE_AREA, NULL);
    lv_obj_invalidate(lv_screen_active());
    sim_step(20);
}

uint32_t sim_flush_pixels(void) { return g_pixels; }

void sim_step(uint32_t ms)
{
    g_ms += ms;
    lv_timer_handler();
}

const uint16_t *sim_fb(void) { return g_fb; }

void sim_post(uint8_t type, const void *data, uint8_t len)
{
    ui_event_t ev;
    memset(&ev, 0, sizeof ev);
    ev.type = type;
    ev.len = len;
    memcpy(ev.data, data, len);
    ui_handle_event(&ev);
}

uint32_t sim_flushes(void) { return g_flushes; }
