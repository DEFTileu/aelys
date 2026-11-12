#include "screen_fsm.h"

scr_t screen_next(scr_t cur, bool lost_mode, ui_event_type_t ev)
{
    switch (ev) {
    case UI_EV_COMBO_FIRE:
        return SCR_ICE;
    case UI_EV_LOST:
        return lost_mode ? SCR_LOST : SCR_HOME;
    case UI_EV_TOUCH:
        if (cur == SCR_ICE) return lost_mode ? SCR_LOST : SCR_HOME;
        return cur;
    default:
        return cur;
    }
}

scr_t screen_next_pair(scr_t cur, bool lost_mode, ui_pair_t what)
{
    if (what == PAIR_UI_CODE) return (lost_mode || cur == SCR_LOST || cur == SCR_ICE) ? cur : SCR_PAIR;
    return cur == SCR_PAIR && !lost_mode ? SCR_HOME : cur;
}
