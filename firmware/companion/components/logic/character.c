#include "character.h"
#include <string.h>

/* Reactions last three seconds, within the design's 2–5 second range. */
#define REACTION_MS 3000u
/* Provisional: an idle hour is boring; one day apart means she missed you. */
#define BORED_SECONDS 3600u
#define MISSED_SECONDS 86400u

typedef struct { character_mood_t mood; character_reason_t why; character_cue_t cue; bool body; } event_rule_t;
static const event_rule_t EVENTS[CHAR_EVENT_COUNT] = {
    [CHAR_EVENT_SHAKE] = {CHAR_DIZZY, WHY_SHAKE, CUE_NONE, true},
    [CHAR_EVENT_FALL] = {CHAR_FRIGHTENED, WHY_FALL, CUE_FRIGHT, true},
    [CHAR_EVENT_TURN] = {CHAR_CURIOUS, WHY_TURN, CUE_NONE, true},
    [CHAR_EVENT_TOUCH] = {CHAR_SURPRISED, WHY_TOUCH, CUE_SURPRISE, false},
    [CHAR_EVENT_DOUBLE_TOUCH] = {CHAR_TICKLED, WHY_DOUBLE_TOUCH, CUE_NONE, false},
    [CHAR_EVENT_STROKE] = {CHAR_TENDER, WHY_STROKE, CUE_TENDER, false},
    [CHAR_EVENT_POKES] = {CHAR_IRRITATED, WHY_POKES, CUE_NONE, false},
    [CHAR_EVENT_NOTIFICATION] = {CHAR_CURIOUS, WHY_NOTIFICATION, CUE_NONE, false},
    [CHAR_EVENT_LOUD] = {CHAR_FRIGHTENED, WHY_LOUD, CUE_FRIGHT, false},
    [CHAR_EVENT_TASK_DONE] = {CHAR_JOY, WHY_TASK_DONE, CUE_JOY, false},
    [CHAR_EVENT_LAST_TASK] = {CHAR_ELATION, WHY_LAST_TASK, CUE_ELATION, false},
    [CHAR_EVENT_TASK_NEAR_DEADLINE] = {CHAR_RELIEF, WHY_TASK_NEAR_DEADLINE, CUE_NONE, false},
    [CHAR_EVENT_LIFT] = {CHAR_ATTENTION, WHY_LIFT, CUE_NONE, false},
    [CHAR_EVENT_RECONNECTED] = {CHAR_RECONNECTED, WHY_RECONNECTED, CUE_NONE, false},
    [CHAR_EVENT_WAKE] = {CHAR_WAKING, WHY_WAKE, CUE_NONE, false},
    [CHAR_EVENT_TILT] = {CHAR_CURIOUS, WHY_TILT, CUE_NONE, false},
    [CHAR_EVENT_HOLD] = {CHAR_BASHFUL, WHY_HOLD, CUE_NONE, false},
    [CHAR_EVENT_RESCHEDULE] = {CHAR_DISAPPOINTED, WHY_RESCHEDULE, CUE_NONE, false},
};

void character_init(character_state_t *s)
{
    if (s) memset(s, 0, sizeof *s);
}

void character_event(character_state_t *s, character_event_t e, uint32_t now)
{
    if (!s || e <= CHAR_EVENT_NONE || e >= CHAR_EVENT_COUNT) return;
    /* A body reaction must not be displaced by a lower-priority tap. */
    if (s->event_pending && s->event > CHAR_EVENT_NONE && s->event < CHAR_EVENT_COUNT &&
        (uint32_t)(now - s->event_at_ms) < REACTION_MS && EVENTS[s->event].body && !EVENTS[e].body) return;
    s->event = e; s->event_at_ms = now; s->event_pending = true; s->cue_pending = true;
}

static character_result_t result(character_mood_t mood, character_reason_t why)
{
    return (character_result_t){mood, why, CUE_NONE};
}

character_result_t character_select(character_state_t *s, const character_inputs_t *i, uint32_t now)
{
    if (!s || !i) return result(CHAR_CALM, WHY_CALM);
    bool active = s->event_pending && s->event > CHAR_EVENT_NONE && s->event < CHAR_EVENT_COUNT &&
                  (uint32_t)(now - s->event_at_ms) < REACTION_MS;
    if (!active) { s->event_pending = false; s->cue_pending = false; }
    const event_rule_t *ev = active ? &EVENTS[s->event] : NULL;
    character_result_t out;
    bool event_selected = false;
    if (i->face_down_known && i->face_down) out = result(CHAR_SLEEPING, WHY_FACE_DOWN);
    else if (i->clock_known && i->night && i->no_touch_at_night) out = result(CHAR_SLEEPING, WHY_NIGHT_SLEEP);
    else if (ev && ev->body) { out = result(ev->mood, ev->why); event_selected = true; }
    else if (i->battery_known && i->battery_percent < 15) out = result(CHAR_EXHAUSTED, WHY_LOW_BATTERY);
    else if (i->battery_known && i->charging) out = result(CHAR_CHARGING, WHY_CHARGING);
    else if (ev) { out = result(ev->mood, ev->why); event_selected = true; }
    else if (i->deadline_known && i->deadline_seconds >= 0 && i->deadline_seconds < 600) out = result(CHAR_PANIC, WHY_DEADLINE_PANIC);
    else if (i->deadline_known && i->deadline_seconds >= 0 && i->deadline_seconds < 3600) out = result(CHAR_ANXIETY, WHY_DEADLINE_ANXIETY);
    else if ((i->tasks_known && i->overdue > 0) || (i->deadline_known && i->deadline_seconds < 0)) out = result(CHAR_SAD, WHY_OVERDUE);
    else if (i->focus_known && i->focus_active && (i->focus_seconds > 1500 || i->focus_streak >= 3)) out = result(CHAR_FLOW, WHY_FLOW);
    else if (i->focus_known && i->focus_active) out = result(CHAR_FOCUSED, WHY_FOCUS);
    else if (i->calendar_known && i->event_soon) out = result(CHAR_ANTICIPATION, WHY_CALENDAR);
    else if (i->waiting_known && i->waiting) out = result(CHAR_THINKING, WHY_WAITING);
    else if (i->link_known && !i->online) out = result(CHAR_OFFLINE, WHY_OFFLINE);
    else if (i->tasks_known && i->today_total > 0 && i->today_done >= i->today_total) out = result(CHAR_ELATION, WHY_ALL_DONE);
    else if (i->clear_week_known && i->clear_week) out = result(CHAR_PRIDE, WHY_CLEAR_WEEK);
    else if (i->absence_known && i->absence_seconds > MISSED_SECONDS) out = result(CHAR_MISSED, WHY_MISSED);
    else if (i->idle_known && i->idle_seconds >= BORED_SECONDS && !(i->clock_known && i->night)) out = result(CHAR_BORED, WHY_BORED);
    else if (i->clock_known && i->morning) out = result(CHAR_WAKING, WHY_MORNING);
    else if (i->clock_known && i->evening) out = result(CHAR_SLEEPY, WHY_EVENING);
    else if (i->idle_known) {
        uint32_t slot = i->idle_seconds / 60u;
        if (!s->background_started) {
            s->background_started = true; s->background_slot = slot; s->last_background = CHAR_CALM;
        } else if (slot != s->background_slot) {
            s->background_slot = slot;
            s->last_background = s->last_background == CHAR_CALM ? CHAR_ATTENTION :
                                 s->last_background == CHAR_ATTENTION ? CHAR_MISCHIEF : CHAR_CALM;
        }
        out = result(s->last_background, s->last_background == CHAR_ATTENTION ? WHY_IDLE_ATTENTION :
                     s->last_background == CHAR_MISCHIEF ? WHY_IDLE_MISCHIEF : WHY_CALM);
    } else out = result(CHAR_CALM, WHY_CALM);
    /* A suppressed event must never start playing late when a higher-priority
       condition or quiet mode ends. Firmware has no character-cue output. */
    if (s->cue_pending) {
        if (event_selected && !i->quiet && i->clock_known && !i->night &&
            i->focus_known && !i->focus_active) out.cue = ev->cue;
        s->cue_pending = false;
    }
    return out;
}
