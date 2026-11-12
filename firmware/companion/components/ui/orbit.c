/* Task orbit: dots on a ring near the display edge. Geometry and colours from the design's
 * CompanionOrbit.dc.html: radius size/2 - 18, done dot 12 px lit, pending dot 9 px dim, first dot at 12 o'clock.
 * The design's glow (box-shadow) is left out: no shadows on this renderer. */
#include "ui_screens_priv.h"

#define ORBIT_MAX 12
#define ORBIT_PLACEHOLDER 8

/* lv_trigo_* is scaled by 32768 */
static int32_t scaled(int32_t r, int32_t t) { return (r * t + (t < 0 ? -16384 : 16384)) / 32768; }

lv_obj_t *orbit_create(lv_obj_t *parent, int32_t size)
{
    lv_obj_t *o = ui_plain(parent, size, size);
    lv_obj_set_pos(o, 0, 0);
    for (int i = 0; i < ORBIT_MAX; i++) {
        lv_obj_t *d = ui_plain(o, 9, 9);
        lv_obj_set_style_radius(d, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_opa(d, LV_OPA_COVER, 0);
    }
    orbit_set(o, 0, 0);
    return o;
}

void orbit_set(lv_obj_t *orbit, int done, int total)
{
    int32_t size = lv_obj_get_width(orbit), r = size / 2 - 18;
    if (total <= 0) { total = ORBIT_PLACEHOLDER; done = 0; }
    if (total > ORBIT_MAX) total = ORBIT_MAX;
    if (done > total) done = total;
    if (done < 0) done = 0;
    for (int i = 0; i < ORBIT_MAX; i++) {
        lv_obj_t *d = lv_obj_get_child(orbit, i);
        lv_obj_set_hidden(d, i >= total);
        if (i >= total) continue;
        bool on = i < done;
        int32_t dia = on ? 12 : 9;
        /* angle = -90 + i * 360 / total degrees, clockwise from 12 o'clock */
        int32_t a = (270 + i * 360 / total) % 360;
        int32_t cx = size / 2 + scaled(r, lv_trigo_cos((int16_t)a));
        int32_t cy = size / 2 + scaled(r, lv_trigo_sin((int16_t)a));
        lv_obj_set_size(d, dia, dia);
        lv_obj_set_pos(d, cx - dia / 2, cy - dia / 2);
        lv_obj_set_style_bg_color(d, lv_color_hex(on ? UI_COLOR_ACCENT : UI_COLOR_ORBIT_OFF), 0);
    }
}
