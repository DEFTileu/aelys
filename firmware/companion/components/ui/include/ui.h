#pragma once
/* Aelys companion UI: mood/face API. Portable C: only lvgl.h + libc, no IDF headers. */
#include <stdint.h>
#include "lvgl.h"
#include "owner.h"
#include "character.h"
#include "proto.h"
#include "snap.h"
#include "tribuf.h"
#include "ui_events.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    MOOD_CALM, MOOD_HAPPY, MOOD_PROUD, MOOD_FOCUSED, MOOD_WORRIED, MOOD_SAD, MOOD_SURPRISED,
    MOOD_CURIOUS, MOOD_SLEEPY, MOOD_SLEEPING, MOOD_DIZZY, MOOD_ANNOYED, MOOD_LOVE, MOOD_OFFLINE,
    MOOD_ATTENTION, MOOD_FLOW, MOOD_ELATION, MOOD_RELIEF, MOOD_PANIC, MOOD_DISAPPOINTED,
    MOOD_ANTICIPATION, MOOD_THINKING, MOOD_FRIGHTENED, MOOD_TICKLED, MOOD_BASHFUL,
    MOOD_MISCHIEF, MOOD_WAKING, MOOD_BORED, MOOD_MISSED, MOOD_EXHAUSTED,
    MOOD_CHARGING, MOOD_RECONNECTED, MOOD_COUNT
} mood_t;

/* Face is 280x160 px at scale_x100 == 100 (fx like the "!" glyph may overflow the box).
 * Returns NULL on bad parent or out of memory. The face starts as MOOD_CALM. */
lv_obj_t *face_create(lv_obj_t *parent, int32_t scale_x100);
void face_set_mood(lv_obj_t *face, mood_t m);
/* Lower-case name ("calm", ...); "?" for an out-of-range value. */
const char *mood_name(mood_t m);
mood_t mood_from_character(character_mood_t mood);

/* Screens (home, lost mode, ICE card). ui_setup() builds them on the active LVGL screen: it is the
 * lv_port_start callback, so call it with the LVGL lock held. ui_handle_event() applies one event
 * (payloads: UI_EV_TIME = hour, minute; UI_EV_WIFI = ui_wifi_state_t; UI_EV_COMBO_PROGRESS = percent; UI_EV_LOST = 1/0;
 * UI_EV_OWNER = no payload, see ui_owner_tb). Same locking rule. */
void ui_setup(void);
/* The UI owns the owner-data buffers (valid after ui_setup()). A producer fills tribuf_back(&ui_owner_tb),
 * NUL-terminates every string, calls tribuf_publish(), then posts UI_EV_OWNER (len 0); the UI reads
 * tribuf_latest(). The content is what the lost and ICE screens show: lost.on ? lost.shown : owner. */
extern tribuf_t ui_owner_tb; /* owner_info_t */
/* The companion snapshot (valid after ui_setup()). The link task fills tribuf_back(&ui_snap_tb), calls tribuf_publish(),
 * then posts UI_EV_SNAPSHOT (data[0] = 1 live from the server, 0 restored from flash); the UI reads tribuf_latest().
 * Rendering it is the UI's job; until the first publish the reader sees an all-zero snap_t. If the allocation failed ui_snap_tb.slot[0] is NULL
 * and a producer must not publish. */
extern tribuf_t ui_snap_tb; /* snap_t */
void ui_handle_event(const ui_event_t *ev);
/* The action hook (main passes link_post_action): false = refused, and the UI shows "No connection". */
void ui_set_action_sink(bool (*sink)(act_kind_t k, const char *target_id));
/* Runs in the UI task; sink must be non-blocking. */
void ui_set_character_status_sink(void (*sink)(character_mood_t mood, character_reason_t why, uint32_t lost_rev, uint32_t identity));
/* Called before registering the status sink during UI setup. */
void ui_set_lost_revision(uint32_t rev);
#ifndef ESP_PLATFORM
/* Simulator only: the firmware cannot register a character-audio sink. */
void ui_set_character_cue_sink(void (*sink)(character_cue_t cue));
#endif
/* While the find overlay is up, any touch, key or both-buttons hold hides it and calls this (main passes board_audio_stop); the touch or key
 * is used up and does nothing else. Called in the ui task. FIND(0) from the audio task (the sound ended) does not call it. */
void ui_set_find_stop(void (*stop)(void));
/* Wall clock for "today", relative times and the mood (default: time(); returns 0 while the clock is not set). Host tests set it. */
void ui_set_clock(int64_t (*now)(void));

#ifdef __cplusplus
}
#endif
