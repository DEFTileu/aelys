#pragma once
/* Aelys companion UI: mood/face API. Portable C: only lvgl.h + libc, no IDF headers. */
#include <stdint.h>
#include "lvgl.h"

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

#ifdef __cplusplus
}
#endif
