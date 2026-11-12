#pragma once
/* Internal to components/ui: the screens and the helpers they share. One UI instance, so the
 * screens keep their widgets in file-level statics. Not a public API. */
#include "owner.h"
#include "screen_fsm.h"
#include "ui.h"
#include "ui_theme.h"

#define UI_SCREEN_SIZE 466

/* screens.c: helpers */
lv_obj_t *ui_plain(lv_obj_t *parent, int32_t w, int32_t h);      /* transparent, no border/pad, inert */
/* Circle outline `inset` px inside the display. */
lv_obj_t *ui_ring(lv_obj_t *parent, int32_t inset, int32_t width, uint32_t color);
/* One-or-more-line label, LV_LABEL_LONG_MODE_DOTS in a fixed box: text that does not fit ends in "...". */
lv_obj_t *ui_label(lv_obj_t *parent, const lv_font_t *font, uint32_t color, int32_t w, int32_t lines,
                   lv_text_align_t align);
/* Wrapped height of `txt` in `w` px, clamped to `max_lines` lines (at least one). */
int32_t ui_text_height(const char *txt, const lv_font_t *font, int32_t w, int32_t max_lines);
/* Stack the visible objs top to bottom (gap[i] px above o[i]) and centre the stack in
 * [area_y, area_y + area_h) of their parent. x < 0 centres each horizontally, else sets x. */
void ui_stack(lv_obj_t *const o[], const uint8_t gap[], int n, int32_t area_y, int32_t area_h, int32_t x);

scr_t ui_current_screen(void); /* for host tests */

/* orbit.c: task dots on a ring. total == 0 draws 8 dim placeholder dots (nothing paired yet). */
lv_obj_t *orbit_create(lv_obj_t *parent, int32_t size);
void orbit_set(lv_obj_t *orbit, int done, int total);

lv_obj_t *scr_home_create(lv_obj_t *parent);
void scr_home_set_time(uint8_t hour, uint8_t minute);
void scr_home_set_tasks(int done, int total);
void scr_home_set_wifi(uint8_t state); /* ui_wifi_state_t */

lv_obj_t *scr_lost_create(lv_obj_t *parent);
void scr_lost_set_owner(const owner_info_t *o);

lv_obj_t *scr_ice_create(lv_obj_t *parent);
void scr_ice_set_owner(const owner_info_t *o);

/* Both-buttons-held overlay: ring that fills with pct (0..100). */
lv_obj_t *scr_hold_create(lv_obj_t *parent);
void scr_hold_set(int pct);
