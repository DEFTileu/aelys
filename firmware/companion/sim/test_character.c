#include <stdint.h>
#include <string.h>
#include "character.h"
#include "check.h"

static character_inputs_t normal(void)
{
    character_inputs_t i; memset(&i, 0, sizeof i);
    i.clock_known = true; i.link_known = true; i.online = true; i.focus_known = true;
    return i;
}
static void expect(character_state_t *s, character_inputs_t *i, uint32_t t,
                   character_mood_t mood, character_reason_t why)
{
    character_result_t r = character_select(s, i, t);
    CHECK_EQ(r.mood, mood); CHECK_EQ(r.why, why);
}
static void test_priorities(void)
{
    character_state_t s; character_init(&s); character_inputs_t i = normal();
    i.face_down_known = i.face_down = true; i.battery_known = true; i.battery_percent = 5;
    i.deadline_known = true; i.deadline_seconds = 2; i.focus_known = i.focus_active = true;
    i.tasks_known = true; i.today_total = i.today_done = 1;
    character_event(&s, CHAR_EVENT_TOUCH, 10);
    expect(&s, &i, 20, CHAR_SLEEPING, WHY_FACE_DOWN);
    i.face_down = false; expect(&s, &i, 20, CHAR_EXHAUSTED, WHY_LOW_BATTERY);
    i.battery_percent = 50; expect(&s, &i, 20, CHAR_SURPRISED, WHY_TOUCH);
    expect(&s, &i, 3020, CHAR_PANIC, WHY_DEADLINE_PANIC);
    i.deadline_seconds = 600; expect(&s, &i, 3020, CHAR_ANXIETY, WHY_DEADLINE_ANXIETY);
    i.deadline_seconds = 3600; expect(&s, &i, 3020, CHAR_FOCUSED, WHY_FOCUS);
    i.focus_active = false; expect(&s, &i, 3020, CHAR_ELATION, WHY_ALL_DONE);
    i.today_done = 0; expect(&s, &i, 3020, CHAR_CALM, WHY_CALM);
}
static void test_boundaries_and_unknown(void)
{
    character_state_t s; character_init(&s); character_inputs_t i = normal();
    i.deadline_known = true;
    const int seconds[] = {0, 1, 599, 600, 3599, 3600};
    const character_mood_t moods[] = {CHAR_PANIC, CHAR_PANIC, CHAR_PANIC, CHAR_ANXIETY, CHAR_ANXIETY, CHAR_CALM};
    for (unsigned n = 0; n < sizeof seconds / sizeof *seconds; ++n) {
        i.deadline_seconds = seconds[n]; CHECK_EQ(character_select(&s, &i, 0).mood, moods[n]);
    }
    i.tasks_known = true; i.overdue = 1; i.deadline_seconds = 599;
    expect(&s, &i, 0, CHAR_PANIC, WHY_DEADLINE_PANIC);
    i.deadline_seconds = 600; expect(&s, &i, 0, CHAR_ANXIETY, WHY_DEADLINE_ANXIETY);
    i.deadline_seconds = 3600; expect(&s, &i, 0, CHAR_SAD, WHY_OVERDUE);
    i.overdue = 0; i.tasks_known = false;
    i.deadline_known = false; i.battery_percent = 0; i.online = false;
    i.link_known = false; expect(&s, &i, 0, CHAR_CALM, WHY_CALM);
    i.tasks_known = true; i.overdue = 1; expect(&s, &i, 0, CHAR_SAD, WHY_OVERDUE);
    i.overdue = 0; i.today_total = 0; i.today_done = 0; expect(&s, &i, 0, CHAR_CALM, WHY_CALM);
    i.focus_known = i.focus_active = true; i.focus_seconds = 1500;
    expect(&s, &i, 0, CHAR_FOCUSED, WHY_FOCUS);
    i.focus_seconds++; expect(&s, &i, 0, CHAR_FLOW, WHY_FLOW);
    i.focus_seconds = 0; i.focus_streak = 3; expect(&s, &i, 0, CHAR_FLOW, WHY_FLOW);
}
static void test_events_and_sounds(void)
{
    character_state_t s; character_init(&s); character_inputs_t i = normal();
    character_event(&s, CHAR_EVENT_TASK_DONE, UINT32_MAX - 1000);
    character_result_t r = character_select(&s, &i, 0);
    CHECK_EQ(r.mood, CHAR_JOY); CHECK_EQ(r.cue, CUE_JOY);
    r = character_select(&s, &i, 1); CHECK_EQ(r.cue, CUE_NONE);
    expect(&s, &i, 2000, CHAR_CALM, WHY_CALM);
    character_event(&s, CHAR_EVENT_STROKE, 3000); i.quiet = true;
    r = character_select(&s, &i, 3000); CHECK_EQ(r.mood, CHAR_TENDER); CHECK_EQ(r.cue, CUE_NONE);
    i.quiet = false; r = character_select(&s, &i, 3001); CHECK_EQ(r.cue, CUE_NONE);
    character_event(&s, CHAR_EVENT_LOUD, 4000); i.night = true;
    r = character_select(&s, &i, 4000); CHECK_EQ(r.cue, CUE_NONE);
    i.night = false; i.focus_known = i.focus_active = true;
    character_event(&s, CHAR_EVENT_LOUD, 5000);
    r = character_select(&s, &i, 5000); CHECK_EQ(r.cue, CUE_NONE);
    i.focus_active = false; i.clock_known = false;
    character_event(&s, CHAR_EVENT_TASK_DONE, 5100);
    r = character_select(&s, &i, 5100); CHECK_EQ(r.cue, CUE_NONE);
    i.clock_known = true; i.focus_known = false;
    character_event(&s, CHAR_EVENT_TASK_DONE, 5200);
    r = character_select(&s, &i, 5200); CHECK_EQ(r.cue, CUE_NONE);
    i.focus_known = i.focus_active = true;
    character_event(&s, CHAR_EVENT_LOUD, 5000);
    character_event(&s, (character_event_t)CHAR_EVENT_COUNT, 5001);
    expect(&s, &i, 5001, CHAR_FRIGHTENED, WHY_LOUD);
}
static void test_remaining_rules(void)
{
    character_state_t s; character_init(&s); character_inputs_t i = normal();
    i.clock_known = true; i.night = i.no_touch_at_night = true;
    expect(&s, &i, 0, CHAR_SLEEPING, WHY_NIGHT_SLEEP);
    i.night = false; i.battery_known = i.charging = true; i.battery_percent = 60;
    expect(&s, &i, 0, CHAR_CHARGING, WHY_CHARGING);
    i.battery_known = false; i.calendar_known = i.event_soon = true;
    expect(&s, &i, 0, CHAR_ANTICIPATION, WHY_CALENDAR);
    i.event_soon = false; i.waiting_known = i.waiting = true;
    expect(&s, &i, 0, CHAR_THINKING, WHY_WAITING);
    i.waiting = false; i.online = false; expect(&s, &i, 0, CHAR_OFFLINE, WHY_OFFLINE);
    i.online = true; i.clear_week_known = i.clear_week = true;
    expect(&s, &i, 0, CHAR_PRIDE, WHY_CLEAR_WEEK);
    i.clear_week = false; i.absence_known = true; i.absence_seconds = 86401;
    expect(&s, &i, 0, CHAR_MISSED, WHY_MISSED);
    i.absence_known = false; i.idle_known = true; i.idle_seconds = 3600;
    expect(&s, &i, 0, CHAR_BORED, WHY_BORED);
    i.idle_known = false; i.morning = true; expect(&s, &i, 0, CHAR_WAKING, WHY_MORNING);
    i.morning = false; i.evening = true; expect(&s, &i, 0, CHAR_SLEEPY, WHY_EVENING);
}
static void test_all_events(void)
{
    const character_mood_t mood[] = {CHAR_CALM, CHAR_DIZZY, CHAR_FRIGHTENED, CHAR_CURIOUS,
        CHAR_SURPRISED, CHAR_TICKLED, CHAR_TENDER, CHAR_IRRITATED, CHAR_CURIOUS, CHAR_FRIGHTENED,
        CHAR_JOY, CHAR_ELATION, CHAR_RELIEF, CHAR_ATTENTION, CHAR_RECONNECTED, CHAR_WAKING,
        CHAR_CURIOUS, CHAR_BASHFUL, CHAR_DISAPPOINTED, CHAR_ATTENTION};
    character_state_t s; character_inputs_t i = normal();
    for (int e = 1; e < CHAR_EVENT_COUNT; ++e) {
        character_init(&s); character_event(&s, (character_event_t)e, 0);
        CHECK_EQ(character_select(&s, &i, 1).mood, mood[e]);
        CHECK_EQ(character_select(&s, &i, 3000).mood, CHAR_CALM);
    }
    character_init(&s); character_event(&s, CHAR_EVENT_SHAKE, 0);
    character_event(&s, CHAR_EVENT_TOUCH, 1);
    expect(&s, &i, 2, CHAR_DIZZY, WHY_SHAKE);
    expect(&s, &i, 3000, CHAR_CALM, WHY_CALM);
}
/* Background reconnect must not interrupt an immediately visible task reaction. */
static void test_reconnect_does_not_interrupt_task(void)
{
    character_state_t s; character_inputs_t i = normal();
    character_init(&s);
    character_event(&s, CHAR_EVENT_TASK_DONE, 0);
    CHECK_EQ(character_select(&s, &i, 0).cue, CUE_JOY);
    character_event(&s, CHAR_EVENT_RECONNECTED, 1000);
    expect(&s, &i, 1000, CHAR_JOY, WHY_TASK_DONE);
    CHECK_EQ(character_select(&s, &i, 1000).cue, CUE_NONE);
    expect(&s, &i, 3000, CHAR_CALM, WHY_CALM);
    character_event(&s, CHAR_EVENT_RECONNECTED, 3001);
    expect(&s, &i, 3001, CHAR_RECONNECTED, WHY_RECONNECTED);
    character_event(&s, CHAR_EVENT_TASK_DONE, 3002);
    expect(&s, &i, 3002, CHAR_JOY, WHY_TASK_DONE);
    character_event(&s, CHAR_EVENT_TOUCH, 3003);
    expect(&s, &i, 3003, CHAR_SURPRISED, WHY_TOUCH);

    const character_event_t tasks[] = {CHAR_EVENT_TASK_DONE, CHAR_EVENT_LAST_TASK, CHAR_EVENT_TASK_NEAR_DEADLINE};
    const character_reason_t reasons[] = {WHY_TASK_DONE, WHY_LAST_TASK, WHY_TASK_NEAR_DEADLINE};
    for (unsigned n = 0; n < sizeof tasks / sizeof *tasks; ++n) {
        character_init(&s);
        CHECK(character_event(&s, tasks[n], UINT32_MAX - 1000u));
        CHECK(!character_event(&s, CHAR_EVENT_RECONNECTED, 0));
        CHECK_EQ(character_select(&s, &i, 0).why, reasons[n]);
        CHECK(character_event(&s, CHAR_EVENT_RECONNECTED, 2000));
        CHECK_EQ(character_select(&s, &i, 2000).why, WHY_RECONNECTED);
    }
}
static void test_cue_mapping(void)
{
    const character_event_t events[] = {CHAR_EVENT_TASK_DONE, CHAR_EVENT_LAST_TASK, CHAR_EVENT_TOUCH,
        CHAR_EVENT_FALL, CHAR_EVENT_STROKE};
    const character_cue_t cues[] = {CUE_JOY, CUE_ELATION, CUE_SURPRISE, CUE_FRIGHT, CUE_TENDER};
    character_inputs_t i = normal(); character_state_t s;
    for (unsigned n = 0; n < sizeof events / sizeof *events; n++) {
        character_init(&s); character_event(&s, events[n], 10);
        CHECK_EQ(character_select(&s, &i, 10).cue, cues[n]);
        CHECK_EQ(character_select(&s, &i, 11).cue, CUE_NONE);
    }
}
static void test_idle_rotation(void)
{
    character_state_t s; character_init(&s); character_inputs_t i = normal();
    i.idle_known = true;
    character_mood_t first = character_select(&s, &i, 0).mood;
    CHECK_EQ(character_select(&s, &i, 100).mood, first);
    i.idle_seconds = 60; character_mood_t second = character_select(&s, &i, 60000).mood;
    CHECK(first != second); i.idle_seconds = 120;
    CHECK(character_select(&s, &i, 120000).mood != second);
}
int main(void) { test_reconnect_does_not_interrupt_task(); test_cue_mapping(); test_remaining_rules(); test_all_events(); test_idle_rotation(); test_priorities(); test_boundaries_and_unknown(); test_events_and_sounds(); return g_failed ? 1 : 0; }
