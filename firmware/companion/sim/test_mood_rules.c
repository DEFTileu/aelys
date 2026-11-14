/* Character input adapter from snapshot and UI time. */
#include <string.h>
#include "check.h"
#include "ui_screens_priv.h"

#define NOW 1000000

static snap_t calm_day(void)
{
    snap_t s;
    memset(&s, 0, sizeof s);
    s.today_done = 2;
    s.today_total = 5;
    return s;
}

static void test_character_snapshot_adapter(void)
{
    snap_t s = calm_day();
    s.has_task = true; s.task.due = NOW + 599;
    s.focus.status = FOCUS_ACTIVE; s.focus.elapsed_s = 1499;
    s.has_event = true; s.event.starts = NOW + 900;
    character_inputs_t i = ui_character_inputs(&s, NOW, true, 14, true, true, UINT32_MAX - 999, 1001);
    CHECK(i.tasks_known && i.deadline_known && i.focus_known && i.calendar_known);
    CHECK_EQ(i.deadline_seconds, 599); CHECK_EQ(i.focus_seconds, 1501);
    CHECK(i.focus_active && i.event_soon && i.link_known && i.online);
    character_state_t state; character_init(&state);
    character_result_t r = character_select(&state, &i, 1001);
    CHECK_EQ(r.mood, CHAR_PANIC); CHECK_EQ(r.why, WHY_DEADLINE_PANIC);
    s.task.due = NOW + 3600; i = ui_character_inputs(&s, NOW, true, 14, true, true, 0, 2000);
    r = character_select(&state, &i, 2000); CHECK_EQ(r.mood, CHAR_FLOW);
    i = ui_character_inputs(NULL, 0, false, 255, false, false, 0, 0);
    CHECK(!i.clock_known && !i.tasks_known && !i.focus_known && !i.link_known && !i.deadline_known);
    s.today_total = -1; s.has_event = false;
    i = ui_character_inputs(&s, 0, false, 255, false, false, 0, 0);
    CHECK(!i.tasks_known && !i.deadline_known && !i.calendar_known);
    i = ui_character_inputs(&s, NOW, true, 23, true, true, 0, 0); CHECK(i.clock_known && i.night);
}

int main(void)
{
    test_character_snapshot_adapter();
    return g_failed ? 1 : 0;
}
