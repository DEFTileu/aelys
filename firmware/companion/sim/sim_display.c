#include "sim_display.h"
#include <string.h>
#include "ui.h"
#include "ui_theme.h"

static uint16_t g_fb[SIM_W * SIM_H];
static uint32_t g_ms, g_flushes;

static uint32_t tick_cb(void) { return g_ms; }

static void flush_cb(lv_display_t *d, const lv_area_t *a, uint8_t *px)
{
    (void)a; (void)px; /* FULL render mode draws straight into g_fb */
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
    lv_display_set_buffers(lv_display_get_default(), g_fb, NULL, sizeof g_fb, LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_obj_invalidate(lv_screen_active());
    sim_step(20);
}

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
