#pragma once
#include <stdbool.h>
#include "ui_events.h"

typedef enum { SCR_HOME, SCR_ICE, SCR_LOST, SCR_TODAY, SCR_FOCUS, SCR_INBOX, SCR_PAIR, SCR_MENU, SCR_PLACEHOLDER, SCR_TASKS, SCR_TIMER, SCR_CALENDAR, SCR_SETTINGS, SCR_WIFI, SCR_ABOUT, SCR_GAMES, SCR_WEATHER, SCR_COUNT } scr_t;

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

/* Swipes (UI_EV_SWIPE_RIGHT: HOME -> TODAY, FOCUS -> HOME; UI_EV_SWIPE_LEFT: HOME -> FOCUS, TODAY -> HOME) go through
 * screen_next() above. A tap and a key click carry a payload screen_next() does not see, so they have their own entry points.
 * In lost mode none of them moves anything. The inbox 15 s timeout is the UI layer's: it arms a timer on entering SCR_INBOX
 * and on expiry calls screen_next_btn(SCR_INBOX, lost_mode, BTN_LOW). */
typedef enum { TAP_OUTSIDE, TAP_UNREAD_ROW, TAP_ROW } tap_hit_t; /* where a tap landed on the current screen */
scr_t screen_next_tap(scr_t cur, bool lost_mode, tap_hit_t hit);  /* TODAY + unread row -> INBOX; INBOX + outside the rows -> TODAY */
scr_t screen_next_btn(scr_t cur, bool lost_mode, ui_btn_t btn);   /* BTN_LOW: TODAY/FOCUS -> HOME, INBOX -> TODAY, MENU -> HOME, PLACEHOLDER, TASKS, TIMER and CALENDAR and GAMES and WEATHER -> MENU, SETTINGS -> MENU, WIFI and ABOUT -> SETTINGS; BTN_TOP: HOME -> MENU */

/* The menu wheel (SCR_MENU) opens from HOME with BTN_TOP. Its swipes turn the wheel inside the UI layer (screen_next() leaves
 * them alone); the top key and a tap on the selected item open `target`, the screen the menu table names for it. Lost mode: never. Settings opens its Wi-Fi and About screens the same way. */
scr_t screen_next_open(scr_t cur, bool lost_mode, scr_t target);

/* A tap on the new-notice pop-up opens the Inbox from any everyday screen (home, menu and the apps). Lost mode, the ICE card and the
 * pairing screen never show the pop-up, so they stay where they are. */
scr_t screen_next_notice(scr_t cur, bool lost_mode);
