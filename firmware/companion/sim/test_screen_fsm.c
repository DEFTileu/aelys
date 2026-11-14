#include <string.h>
#include "check.h"
#include "owner.h"
#include "owner_contact.example.h"
#include "screen_fsm.h"

static void test_combo_opens_ice_from_home(void)
{
    CHECK_EQ(screen_next(SCR_HOME, false, UI_EV_COMBO_FIRE), SCR_ICE);
}
static void test_combo_opens_ice_from_lost(void)
{
    CHECK_EQ(screen_next(SCR_LOST, true, UI_EV_COMBO_FIRE), SCR_ICE);
}
static void test_ice_returns_to_lost_when_lost_mode(void)
{
    CHECK_EQ(screen_next(SCR_ICE, true, UI_EV_TOUCH), SCR_LOST);
    CHECK_EQ(screen_next(SCR_ICE, false, UI_EV_TOUCH), SCR_HOME);
}
static void test_buttons_cannot_leave_lost(void)
{
    ui_event_type_t evs[] = { UI_EV_BTN, UI_EV_TOUCH, UI_EV_COMBO_PROGRESS, UI_EV_TICK,
                              UI_EV_TIME, UI_EV_WIFI, UI_EV_OWNER };
    for (unsigned i = 0; i < sizeof evs / sizeof *evs; i++)
        CHECK_EQ(screen_next(SCR_LOST, true, evs[i]), SCR_LOST);
}
static void test_lost_off_goes_home(void)
{
    CHECK_EQ(screen_next(SCR_LOST, false, UI_EV_LOST), SCR_HOME);
    CHECK_EQ(screen_next(SCR_HOME, true, UI_EV_LOST), SCR_LOST);
    CHECK_EQ(screen_next(SCR_ICE, true, UI_EV_LOST), SCR_LOST);
}
static void test_ice_ignores_non_tap_events(void)
{
    CHECK_EQ(screen_next(SCR_ICE, false, UI_EV_TIME), SCR_ICE);
    CHECK_EQ(screen_next(SCR_HOME, false, UI_EV_TOUCH), SCR_HOME);
}

static void test_pair_code_shows_pair_screen(void)
{
    CHECK_EQ(screen_next_pair(SCR_HOME, false, PAIR_UI_CODE), SCR_PAIR);
    CHECK_EQ(screen_next_pair(SCR_PAIR, false, PAIR_UI_CODE), SCR_PAIR);
    CHECK_EQ(screen_next_pair(SCR_ICE, false, PAIR_UI_CODE), SCR_ICE); /* the emergency card is never covered */
}
static void test_pair_done_returns_home(void)
{
    CHECK_EQ(screen_next_pair(SCR_PAIR, false, PAIR_UI_DONE), SCR_HOME);
    CHECK_EQ(screen_next_pair(SCR_PAIR, false, PAIR_UI_HIDE), SCR_HOME);
    CHECK_EQ(screen_next_pair(SCR_ICE, false, PAIR_UI_HIDE), SCR_ICE);
    CHECK_EQ(screen_next_pair(SCR_HOME, false, PAIR_UI_DONE), SCR_HOME);
}
static void test_pair_code_ignored_in_lost_mode(void)
{
    CHECK_EQ(screen_next_pair(SCR_LOST, true, PAIR_UI_CODE), SCR_LOST);
    CHECK_EQ(screen_next_pair(SCR_HOME, true, PAIR_UI_CODE), SCR_HOME);
    CHECK_EQ(screen_next_pair(SCR_LOST, true, PAIR_UI_DONE), SCR_LOST);
    CHECK_EQ(screen_next_pair(SCR_LOST, true, PAIR_UI_HIDE), SCR_LOST);
}
static void test_pair_screen_follows_lost_and_combo(void)
{
    CHECK_EQ(screen_next(SCR_PAIR, true, UI_EV_LOST), SCR_LOST);
    CHECK_EQ(screen_next(SCR_PAIR, false, UI_EV_COMBO_FIRE), SCR_ICE);
    CHECK_EQ(screen_next(SCR_PAIR, false, UI_EV_TOUCH), SCR_PAIR);
}

static void test_swipe_cycle_today_home_focus(void)
{
    CHECK_EQ(screen_next(SCR_HOME, false, UI_EV_SWIPE_RIGHT), SCR_TODAY);
    CHECK_EQ(screen_next(SCR_HOME, false, UI_EV_SWIPE_LEFT), SCR_FOCUS);
    CHECK_EQ(screen_next(SCR_TODAY, false, UI_EV_SWIPE_LEFT), SCR_HOME);
    CHECK_EQ(screen_next(SCR_FOCUS, false, UI_EV_SWIPE_RIGHT), SCR_HOME);
    /* no wrap-around and no other screen swipes */
    CHECK_EQ(screen_next(SCR_TODAY, false, UI_EV_SWIPE_RIGHT), SCR_TODAY);
    CHECK_EQ(screen_next(SCR_FOCUS, false, UI_EV_SWIPE_LEFT), SCR_FOCUS);
    scr_t other[] = { SCR_INBOX, SCR_ICE, SCR_PAIR };
    for (unsigned i = 0; i < sizeof other / sizeof *other; i++) {
        CHECK_EQ(screen_next(other[i], false, UI_EV_SWIPE_LEFT), other[i]);
        CHECK_EQ(screen_next(other[i], false, UI_EV_SWIPE_RIGHT), other[i]);
    }
}

static void test_inbox_back(void)
{
    CHECK_EQ(screen_next_tap(SCR_TODAY, false, TAP_UNREAD_ROW), SCR_INBOX);
    CHECK_EQ(screen_next_tap(SCR_TODAY, false, TAP_OUTSIDE), SCR_TODAY);
    CHECK_EQ(screen_next_tap(SCR_TODAY, false, TAP_ROW), SCR_TODAY);
    CHECK_EQ(screen_next_tap(SCR_HOME, false, TAP_UNREAD_ROW), SCR_HOME);
    CHECK_EQ(screen_next_tap(SCR_INBOX, false, TAP_OUTSIDE), SCR_TODAY);  /* tap outside the rows */
    CHECK_EQ(screen_next_tap(SCR_INBOX, false, TAP_ROW), SCR_INBOX);
    CHECK_EQ(screen_next_btn(SCR_INBOX, false, BTN_LOW), SCR_TODAY);
    CHECK_EQ(screen_next_btn(SCR_INBOX, false, BTN_TOP), SCR_INBOX);
    CHECK_EQ(screen_next_btn(SCR_TODAY, false, BTN_LOW), SCR_HOME);
    CHECK_EQ(screen_next_btn(SCR_FOCUS, false, BTN_LOW), SCR_HOME);
    CHECK_EQ(screen_next_btn(SCR_HOME, false, BTN_LOW), SCR_HOME);
    CHECK_EQ(screen_next_btn(SCR_FOCUS, false, BTN_TOP), SCR_FOCUS);
    CHECK_EQ(screen_next_btn(SCR_ICE, false, BTN_LOW), SCR_ICE);
}

static void test_swipes_ignored_in_lost_mode(void)
{
    CHECK_EQ(screen_next(SCR_LOST, true, UI_EV_SWIPE_LEFT), SCR_LOST);
    CHECK_EQ(screen_next(SCR_LOST, true, UI_EV_SWIPE_RIGHT), SCR_LOST);
    CHECK_EQ(screen_next(SCR_LOST, true, UI_EV_TAP), SCR_LOST);
    CHECK_EQ(screen_next(SCR_LOST, true, UI_EV_RELEASE), SCR_LOST);
    CHECK_EQ(screen_next_tap(SCR_LOST, true, TAP_UNREAD_ROW), SCR_LOST);
    CHECK_EQ(screen_next_btn(SCR_LOST, true, BTN_LOW), SCR_LOST);
    /* the ICE card opened over lost mode returns to it: swipes do not move it, and a home that is
     * still showing while the flag is on (the instant before the screen switches) does not leave either */
    CHECK_EQ(screen_next(SCR_ICE, true, UI_EV_SWIPE_RIGHT), SCR_ICE);
    CHECK_EQ(screen_next(SCR_HOME, true, UI_EV_SWIPE_RIGHT), SCR_HOME);
    CHECK_EQ(screen_next(SCR_TODAY, true, UI_EV_SWIPE_LEFT), SCR_TODAY);
    CHECK_EQ(screen_next_btn(SCR_TODAY, true, BTN_LOW), SCR_TODAY);
}

static void test_menu_opens_and_closes(void)
{
    CHECK_EQ(screen_next_btn(SCR_HOME, false, BTN_TOP), SCR_MENU);
    CHECK_EQ(screen_next_btn(SCR_MENU, false, BTN_LOW), SCR_HOME);
    CHECK_EQ(screen_next_btn(SCR_MENU, false, BTN_TOP), SCR_MENU);        /* opening the item is screen_next_open() */
    CHECK_EQ(screen_next_btn(SCR_PLACEHOLDER, false, BTN_LOW), SCR_MENU);
    CHECK_EQ(screen_next_btn(SCR_PLACEHOLDER, false, BTN_TOP), SCR_PLACEHOLDER);
    CHECK_EQ(screen_next_btn(SCR_TASKS, false, BTN_LOW), SCR_MENU);       /* Tasks goes back to the menu it was opened from */
    CHECK_EQ(screen_next_btn(SCR_TASKS, false, BTN_TOP), SCR_TASKS);      /* the top key completes the task: the UI layer's */
    CHECK_EQ(screen_next_btn(SCR_TASKS, true, BTN_LOW), SCR_TASKS);
    CHECK_EQ(screen_next_open(SCR_MENU, false, SCR_TASKS), SCR_TASKS);
    CHECK_EQ(screen_next_open(SCR_MENU, false, SCR_TIMER), SCR_TIMER);
    CHECK_EQ(screen_next_open(SCR_MENU, true, SCR_TIMER), SCR_MENU);
    CHECK_EQ(screen_next_btn(SCR_TIMER, false, BTN_LOW), SCR_MENU);        /* Timer goes back to the menu it was opened from */
    CHECK_EQ(screen_next_btn(SCR_TIMER, false, BTN_TOP), SCR_TIMER);       /* the top key is the UI layer's: start / pause */
    CHECK_EQ(screen_next_btn(SCR_TIMER, true, BTN_LOW), SCR_TIMER);
    CHECK_EQ(screen_next_btn(SCR_FOCUS, false, BTN_TOP), SCR_FOCUS);      /* the focus key stays the focus action */
    CHECK_EQ(screen_next_btn(SCR_ICE, false, BTN_TOP), SCR_ICE);
    CHECK_EQ(screen_next_btn(SCR_PAIR, false, BTN_TOP), SCR_PAIR);
    CHECK_EQ(screen_next_open(SCR_MENU, false, SCR_FOCUS), SCR_FOCUS);
    CHECK_EQ(screen_next_open(SCR_MENU, false, SCR_PLACEHOLDER), SCR_PLACEHOLDER);
    CHECK_EQ(screen_next_open(SCR_HOME, false, SCR_FOCUS), SCR_HOME);     /* only the menu opens items */
    CHECK_EQ(screen_next(SCR_MENU, false, UI_EV_SWIPE_LEFT), SCR_MENU);   /* swipes turn the wheel, not the screen */
    CHECK_EQ(screen_next(SCR_MENU, false, UI_EV_SWIPE_RIGHT), SCR_MENU);
    CHECK_EQ(screen_next(SCR_MENU, false, UI_EV_COMBO_FIRE), SCR_ICE);
}

static void test_menu_never_opens_in_lost_mode(void)
{
    CHECK_EQ(screen_next_btn(SCR_HOME, true, BTN_TOP), SCR_HOME);
    CHECK_EQ(screen_next_btn(SCR_LOST, true, BTN_TOP), SCR_LOST);
    CHECK_EQ(screen_next_btn(SCR_MENU, true, BTN_LOW), SCR_MENU);
    CHECK_EQ(screen_next_open(SCR_MENU, true, SCR_FOCUS), SCR_MENU);
    CHECK_EQ(screen_next(SCR_MENU, true, UI_EV_LOST), SCR_LOST);          /* lost mode switching on takes the menu away */
    CHECK_EQ(screen_next(SCR_PLACEHOLDER, true, UI_EV_LOST), SCR_LOST);
}

static int terminated(const char *s, size_t cap) { return memchr(s, '\0', cap) != NULL; }

static void test_owner_defaults(void)
{
    owner_info_t o;
    memset(&o, 0xAA, sizeof o);
    owner_defaults(&o);
    CHECK(strcmp(o.phone, OWNER_PHONE) == 0);
    CHECK(strcmp(o.telegram, OWNER_TELEGRAM) == 0);
    CHECK(strcmp(o.qr_url, OWNER_QR_URL) == 0);
    CHECK(strcmp(o.message, "If found, please contact") == 0);
    CHECK_EQ(o.name[0], 0);
    CHECK_EQ(o.med_note[0], 0);
    CHECK(terminated(o.name, sizeof o.name));
    CHECK(terminated(o.phone, sizeof o.phone));
    CHECK(terminated(o.telegram, sizeof o.telegram));
    CHECK(terminated(o.qr_url, sizeof o.qr_url));
    CHECK(terminated(o.message, sizeof o.message));
    CHECK(terminated(o.med_note, sizeof o.med_note));
    for (int i = 0; i < 2; i++) {
        CHECK(terminated(o.ice_name[i], sizeof o.ice_name[i]));
        CHECK(terminated(o.ice_phone[i], sizeof o.ice_phone[i]));
    }
}

/* The find overlay is not a screen: UI_EV_FIND never moves the current one, least of all out of lost mode or the emergency card. */
static void test_find_overlay_does_not_leave_lost(void)
{
    for (int s = 0; s < SCR_COUNT; s++) {
        CHECK_EQ(screen_next((scr_t)s, false, UI_EV_FIND), (scr_t)s);
        CHECK_EQ(screen_next((scr_t)s, true, UI_EV_FIND), (scr_t)s);
    }
    CHECK_EQ(screen_next(SCR_LOST, true, UI_EV_FIND), SCR_LOST);
    CHECK_EQ(screen_next(SCR_ICE, true, UI_EV_FIND), SCR_ICE);
}

int main(void)
{
    test_combo_opens_ice_from_home();
    test_combo_opens_ice_from_lost();
    test_ice_returns_to_lost_when_lost_mode();
    test_buttons_cannot_leave_lost();
    test_lost_off_goes_home();
    test_ice_ignores_non_tap_events();
    test_pair_code_shows_pair_screen();
    test_pair_done_returns_home();
    test_pair_code_ignored_in_lost_mode();
    test_pair_screen_follows_lost_and_combo();
    test_swipe_cycle_today_home_focus();
    test_inbox_back();
    test_swipes_ignored_in_lost_mode();
    test_menu_opens_and_closes();
    test_menu_never_opens_in_lost_mode();
    test_owner_defaults();
    test_find_overlay_does_not_leave_lost();
    return g_failed ? 1 : 0;
}
