#pragma once
#include <stdbool.h>
#include "ui_events.h"

typedef enum { SCR_HOME, SCR_ICE, SCR_LOST, SCR_TODAY, SCR_FOCUS, SCR_INBOX, SCR_PAIR, SCR_COUNT } scr_t;

/* Next screen for an event. `lost_mode` is the lost-mode flag AFTER the event: for UI_EV_LOST it
 * is the new value (on -> SCR_LOST, off -> SCR_HOME).
 * Rules: UI_EV_COMBO_FIRE opens SCR_ICE from anywhere; UI_EV_TOUCH on SCR_ICE returns to SCR_LOST
 * (lost_mode) or SCR_HOME; in lost_mode nothing else leaves SCR_LOST/SCR_ICE.
 * The 15 s ICE timeout needs a clock, which this signature lacks: the UI layer (Task 6 screens)
 * arms a 15 s timer on entering SCR_ICE and, on expiry, calls screen_next(SCR_ICE, lost_mode,
 * UI_EV_TOUCH). UI_EV_TICK is a no-op here. */
scr_t screen_next(scr_t cur, bool lost_mode, ui_event_type_t ev);

/* Same for UI_EV_PAIR (whose payload screen_next() does not see). CODE opens SCR_PAIR, except from lost
 * mode or over the emergency card; DONE and HIDE leave SCR_PAIR for SCR_HOME and are no-ops elsewhere.
 * "Paired" stays up for 2 s: the UI layer shows it on DONE and arms a timer that calls
 * screen_next_pair(SCR_PAIR, lost_mode, PAIR_UI_DONE) on expiry, like the ICE timeout. */
scr_t screen_next_pair(scr_t cur, bool lost_mode, ui_pair_t what);
