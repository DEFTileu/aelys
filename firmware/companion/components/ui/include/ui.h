#pragma once
/* Aelys companion UI: mood/face API. Portable C: only lvgl.h + libc, no IDF headers. */
#include <stdint.h>
#include "lvgl.h"
#include "ui_events.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    MOOD_CALM, MOOD_HAPPY, MOOD_PROUD, MOOD_FOCUSED, MOOD_WORRIED, MOOD_SAD, MOOD_SURPRISED,
    MOOD_CURIOUS, MOOD_SLEEPY, MOOD_SLEEPING, MOOD_DIZZY, MOOD_ANNOYED, MOOD_LOVE, MOOD_OFFLINE,
    MOOD_COUNT
} mood_t;

/* Face is 280x160 px at scale_x100 == 100 (fx like the "!" glyph may overflow the box).
 * Returns NULL on bad parent or out of memory. The face starts as MOOD_CALM. */
lv_obj_t *face_create(lv_obj_t *parent, int32_t scale_x100);
void face_set_mood(lv_obj_t *face, mood_t m);
/* Lower-case name ("calm", ...); "?" for an out-of-range value. */
const char *mood_name(mood_t m);

/* Screens (home, lost mode, ICE card). ui_setup() builds them on the active LVGL screen: it is the
 * lv_port_start callback, so call it with the LVGL lock held. ui_handle_event() applies one event
 * (payloads: UI_EV_TIME = hour, minute; UI_EV_COMBO_PROGRESS = percent; UI_EV_LOST = 1/0;
 * UI_EV_OWNER = a const owner_info_t * that is copied on receipt). Same locking rule. */
void ui_setup(void);
void ui_handle_event(const ui_event_t *ev);

#ifdef __cplusplus
}
#endif
