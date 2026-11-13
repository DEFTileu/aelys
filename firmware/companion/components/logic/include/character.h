#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Independent of LVGL and devices. Unknown data must not be presented as facts. */
typedef enum {
    CHAR_CALM, CHAR_ATTENTION, CHAR_FOCUSED, CHAR_FLOW, CHAR_JOY, CHAR_ELATION,
    CHAR_PRIDE, CHAR_RELIEF, CHAR_ANXIETY, CHAR_PANIC, CHAR_SAD, CHAR_DISAPPOINTED,
    CHAR_ANTICIPATION, CHAR_THINKING, CHAR_CURIOUS, CHAR_SURPRISED, CHAR_FRIGHTENED,
    CHAR_TICKLED, CHAR_TENDER, CHAR_BASHFUL, CHAR_IRRITATED, CHAR_DIZZY, CHAR_MISCHIEF,
    CHAR_WAKING, CHAR_BORED, CHAR_MISSED, CHAR_SLEEPY, CHAR_SLEEPING, CHAR_EXHAUSTED,
    CHAR_CHARGING, CHAR_OFFLINE, CHAR_RECONNECTED, CHAR_MOOD_COUNT
} character_mood_t;
typedef enum {
    WHY_CALM, WHY_FACE_DOWN, WHY_NIGHT_SLEEP, WHY_SHAKE, WHY_FALL, WHY_TURN,
    WHY_LOW_BATTERY, WHY_CHARGING, WHY_TOUCH, WHY_DOUBLE_TOUCH, WHY_STROKE,
    WHY_POKES, WHY_NOTIFICATION, WHY_LOUD, WHY_TASK_DONE, WHY_LAST_TASK,
    WHY_TASK_NEAR_DEADLINE, WHY_LIFT, WHY_RECONNECTED, WHY_WAKE, WHY_TILT,
    WHY_DEADLINE_PANIC, WHY_DEADLINE_ANXIETY, WHY_OVERDUE, WHY_FLOW, WHY_FOCUS,
    WHY_CALENDAR, WHY_WAITING, WHY_OFFLINE, WHY_ALL_DONE, WHY_CLEAR_WEEK,
    WHY_BORED, WHY_MISSED, WHY_MORNING, WHY_EVENING, WHY_IDLE_ATTENTION,
    WHY_IDLE_MISCHIEF, WHY_HOLD, WHY_RESCHEDULE
} character_reason_t;
typedef enum {
    CHAR_EVENT_NONE, CHAR_EVENT_SHAKE, CHAR_EVENT_FALL, CHAR_EVENT_TURN,
    CHAR_EVENT_TOUCH, CHAR_EVENT_DOUBLE_TOUCH, CHAR_EVENT_STROKE, CHAR_EVENT_POKES,
    CHAR_EVENT_NOTIFICATION, CHAR_EVENT_LOUD, CHAR_EVENT_TASK_DONE,
    CHAR_EVENT_LAST_TASK, CHAR_EVENT_TASK_NEAR_DEADLINE, CHAR_EVENT_LIFT,
    CHAR_EVENT_RECONNECTED, CHAR_EVENT_WAKE, CHAR_EVENT_TILT, CHAR_EVENT_HOLD,
    CHAR_EVENT_RESCHEDULE, CHAR_EVENT_COUNT
} character_event_t;
typedef enum { CUE_NONE, CUE_JOY, CUE_ELATION, CUE_SURPRISE, CUE_FRIGHT, CUE_TENDER } character_cue_t;

typedef struct {
    bool face_down_known, face_down;
    bool clock_known, night, morning, evening, no_touch_at_night;
    bool battery_known, charging; uint8_t battery_percent;
    bool tasks_known; int32_t today_done, today_total, overdue;
    bool deadline_known; int64_t deadline_seconds;
    bool focus_known, focus_active; uint32_t focus_seconds, focus_streak;
    bool calendar_known, event_soon;
    bool waiting_known, waiting;
    bool link_known, online;
    bool clear_week_known, clear_week;
    bool idle_known; uint32_t idle_seconds;
    bool absence_known; uint32_t absence_seconds;
    bool quiet;
} character_inputs_t;
typedef struct {
    character_event_t event; uint32_t event_at_ms; bool event_pending, cue_pending;
    character_mood_t last_background; uint32_t background_slot; bool background_started;
} character_state_t;
typedef struct { character_mood_t mood; character_reason_t why; character_cue_t cue; } character_result_t;
void character_init(character_state_t *state);
void character_event(character_state_t *state, character_event_t event, uint32_t now_ms);
character_result_t character_select(character_state_t *state, const character_inputs_t *inputs, uint32_t now_ms);
