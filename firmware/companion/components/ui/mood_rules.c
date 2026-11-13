#include "ui_screens_priv.h"

mood_t ui_mood_for(const snap_t *s, int64_t now, bool online, bool just_completed)
{
    if (!online) return MOOD_OFFLINE;
    if (s->focus.status == FOCUS_ACTIVE) return MOOD_FOCUSED;
    if (s->overdue > 0) return MOOD_SAD;
    if (now > 0 && s->has_task && s->task.due > 0 && s->task.due - now < 3600) return MOOD_WORRIED;
    if (just_completed) return MOOD_HAPPY;
    if (s->today_total > 0 && s->today_done == s->today_total) return MOOD_PROUD;
    return MOOD_CALM;
}
