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
    case UI_EV_SWIPE_RIGHT:
        if (lost_mode) return cur;
        return cur == SCR_HOME ? SCR_TODAY : cur == SCR_FOCUS ? SCR_HOME : cur;
    case UI_EV_SWIPE_LEFT:
        if (lost_mode) return cur;
        return cur == SCR_HOME ? SCR_FOCUS : cur == SCR_TODAY ? SCR_HOME : cur;
    default:
        return cur;
    }
}

scr_t screen_next_pair(scr_t cur, bool lost_mode, ui_pair_t what)
{
    if (what == PAIR_UI_CODE) return (lost_mode || cur == SCR_LOST || cur == SCR_ICE) ? cur : SCR_PAIR;
    return cur == SCR_PAIR && !lost_mode ? SCR_HOME : cur;
}

scr_t screen_next_tap(scr_t cur, bool lost_mode, tap_hit_t hit)
{
    if (lost_mode) return cur;
    if (cur == SCR_TODAY && hit == TAP_UNREAD_ROW) return SCR_INBOX;
    if (cur == SCR_INBOX && hit == TAP_OUTSIDE) return SCR_TODAY;
    return cur;
}

scr_t screen_next_btn(scr_t cur, bool lost_mode, ui_btn_t btn)
{
    if (lost_mode) return cur;
    if (btn == BTN_TOP) return cur == SCR_HOME ? SCR_MENU : cur;
    if (btn != BTN_LOW) return cur;
    return cur == SCR_TODAY || cur == SCR_FOCUS || cur == SCR_MENU ? SCR_HOME
         : cur == SCR_INBOX ? SCR_TODAY : cur == SCR_PLACEHOLDER || cur == SCR_TASKS || cur == SCR_TIMER || cur == SCR_CALENDAR || cur == SCR_GAMES ? SCR_MENU : cur;
}

scr_t screen_next_open(scr_t cur, bool lost_mode, scr_t target)
{
    return cur == SCR_MENU && !lost_mode && target < SCR_COUNT ? target : cur;
}

scr_t screen_next_notice(scr_t cur, bool lost_mode)
{
    return lost_mode || cur == SCR_LOST || cur == SCR_ICE || cur == SCR_PAIR ? cur : SCR_INBOX;
}
