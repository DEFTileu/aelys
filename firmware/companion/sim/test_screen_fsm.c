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

int main(void)
{
    test_combo_opens_ice_from_home();
    test_combo_opens_ice_from_lost();
    test_ice_returns_to_lost_when_lost_mode();
    test_buttons_cannot_leave_lost();
    test_lost_off_goes_home();
    test_ice_ignores_non_tap_events();
    test_owner_defaults();
    return g_failed ? 1 : 0;
}
