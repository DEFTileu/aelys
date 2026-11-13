#include "ui_screens_priv.h"

character_inputs_t ui_character_inputs(const snap_t *s, int64_t now, bool have_time, uint8_t hour,
                                       bool link_known, bool online, uint32_t snap_ms, uint32_t now_ms)
{
    character_inputs_t i = {0};
    i.link_known = link_known; i.online = online;
    i.clock_known = have_time && hour < 24;
    if (i.clock_known) {
        /* Provisional local-time boundaries, recorded in the stage ledger. */
        i.night = hour >= 22 || hour < 6;
        i.morning = hour >= 6 && hour < 10;
        i.evening = hour >= 20 && hour < 22;
    }
    if (!s) return i;
    i.tasks_known = s->today_total >= 0 && s->today_done >= 0 && s->overdue >= 0;
    if (i.tasks_known) { i.today_total = s->today_total; i.today_done = s->today_done; i.overdue = s->overdue; }
    if (now > 0 && s->has_task && s->task.due > 0) {
        i.deadline_known = true; i.deadline_seconds = s->task.due - now;
    }
    i.focus_known = s->focus.status <= FOCUS_PAUSED;
    i.focus_active = s->focus.status == FOCUS_ACTIVE;
    if (i.focus_active) {
        uint64_t elapsed = s->focus.elapsed_s > 0 ? (uint32_t)s->focus.elapsed_s : 0;
        elapsed += (uint32_t)(now_ms - snap_ms) / 1000u;
        i.focus_seconds = elapsed > UINT32_MAX ? UINT32_MAX : (uint32_t)elapsed;
    }
    if (now > 0 && s->has_event && s->event.starts > 0) {
        i.calendar_known = true;
        int64_t until = s->event.starts - now;
        i.event_soon = until >= 0 && until <= 900;
    }
    return i;
}
