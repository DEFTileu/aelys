/* Screens: screen switching through ui_handle_event(), and the pixel check that no text or
 * widget leaves the round 466 px display, even with every owner field at its maximum length. */
#include <string.h>
#include "check.h"
#include "sim_display.h"
#include "ui_screens_priv.h"

#define R 233 /* display radius, px */

static void fill_w(char *dst, size_t cap)
{
    memset(dst, 'W', cap - 1); /* the widest letter, every byte the field can hold */
    dst[cap - 1] = '\0';
}

static void post_owner(const owner_info_t *o)
{
    *(owner_info_t *)tribuf_back(&ui_owner_tb) = *o;
    tribuf_publish(&ui_owner_tb);
    sim_post(UI_EV_OWNER, NULL, 0);
}
static void post_lost(int on) { uint8_t v = (uint8_t)on; sim_post(UI_EV_LOST, &v, 1); }
static void post_progress(int pct) { uint8_t v = (uint8_t)pct; sim_post(UI_EV_COMBO_PROGRESS, &v, 1); }
static void post(uint8_t type) { sim_post(type, NULL, 0); }

/* Lit pixels outside the circle of radius R (pixel centres), and lit pixels inside it. */
static void count_lit(int *outside, int *inside)
{
    const uint16_t *fb = sim_fb();
    *outside = *inside = 0;
    for (int y = 0; y < SIM_H; y++)
        for (int x = 0; x < SIM_W; x++) {
            if (!fb[y * SIM_W + x]) continue;
            int dx = 2 * x + 1 - SIM_W, dy = 2 * y + 1 - SIM_H; /* doubled: centres are half pixels */
            if (dx * dx + dy * dy > 4 * R * R) (*outside)++;
            else (*inside)++;
        }
}

static void check_inside(const char *what)
{
    int out, in;
    sim_step(100);
    count_lit(&out, &in);
    if (out) fprintf(stderr, "%s: %d lit pixels outside radius %d\n", what, out, R);
    CHECK_EQ(out, 0);
    CHECK(in > 2000); /* something was drawn */
}

static void test_flow(void)
{
    ui_setup();
    CHECK_EQ(ui_current_screen(), SCR_HOME);

    post(UI_EV_COMBO_FIRE);
    CHECK_EQ(ui_current_screen(), SCR_ICE);
    sim_step(14000);
    CHECK_EQ(ui_current_screen(), SCR_ICE);   /* 15 s timeout not reached yet */
    sim_step(1100);
    CHECK_EQ(ui_current_screen(), SCR_HOME);  /* timed out */

    post(UI_EV_COMBO_FIRE);
    post(UI_EV_TOUCH);
    CHECK_EQ(ui_current_screen(), SCR_HOME);  /* tap closes the card */
    sim_step(16000);
    CHECK_EQ(ui_current_screen(), SCR_HOME);  /* and the timer is gone */

    post_lost(1);
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    post(UI_EV_BTN);
    post(UI_EV_TOUCH);
    CHECK_EQ(ui_current_screen(), SCR_LOST);  /* nothing leaves lost mode */
    post(UI_EV_COMBO_FIRE);
    CHECK_EQ(ui_current_screen(), SCR_ICE);   /* except the emergency card */
    post(UI_EV_TOUCH);
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    post(UI_EV_COMBO_FIRE);
    sim_step(15100);
    CHECK_EQ(ui_current_screen(), SCR_LOST);  /* timeout returns to lost mode too */
    post_lost(0);
    CHECK_EQ(ui_current_screen(), SCR_HOME);

    post(UI_EV_COMBO_FIRE);
    post_lost(1);
    CHECK_EQ(ui_current_screen(), SCR_ICE);   /* lost mode on does not close the card ... */
    post(UI_EV_TOUCH);
    CHECK_EQ(ui_current_screen(), SCR_LOST);  /* ... it returns to the right screen */
    post(UI_EV_COMBO_FIRE);
    post_lost(0);
    CHECK_EQ(ui_current_screen(), SCR_ICE);
    post(UI_EV_TOUCH);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
}

static void test_hold_ring(void)
{
    const uint16_t *fb = sim_fb();
    post_progress(50);
    sim_step(100);
    /* ring centre radius is 219 px: clockwise from 12 o'clock, so 3 o'clock is lit and 9 o'clock is the dim track */
    uint16_t right = fb[233 * SIM_W + 233 + 219], left = fb[233 * SIM_W + 233 - 219];
    CHECK(((right >> 11) & 31) > 20);
    CHECK(((left >> 11) & 31) < 8 && left != 0);
    post_progress(0);
    sim_step(100);
    CHECK(((fb[233 * SIM_W + 233 + 219]) >> 11) < 8); /* overlay gone: at most an orbit dot there, not the red ring */
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    post(UI_EV_COMBO_FIRE);
    post_progress(50);                         /* not shown over the card itself */
    sim_step(100);
    CHECK(((fb[233 * SIM_W + 233 - 219]) >> 11) > 20); /* 9 o'clock: the card's own bright ring, not the dim track */
    post(UI_EV_TOUCH);
}

static void test_wifi_status(void)
{
    for (uint8_t st = UI_WIFI_OFFLINE; st <= UI_WIFI_BAD_PASSWORD; st++) {
        sim_post(UI_EV_WIFI, &st, 1);
        check_inside("home wifi status");
    }
    uint8_t bad = 99;
    sim_post(UI_EV_WIFI, &bad, 1);              /* out of range: ignored */
    sim_post(UI_EV_WIFI, NULL, 0);              /* no payload: ignored */
    CHECK_EQ(ui_current_screen(), SCR_HOME);
}

static void test_short_data(void)
{
    static owner_info_t o; /* only the defaults: no name, no contacts */
    owner_defaults(&o);
    post_owner(&o);
    post_lost(1);
    check_inside("lost (defaults)");
    post(UI_EV_COMBO_FIRE);
    check_inside("ice (empty)");
    post(UI_EV_TOUCH);
    post_lost(0);
}

/* A visible label with this exact text anywhere under obj, fully inside the circle, with lit pixels. */
static bool shows_text(lv_obj_t *obj, const char *txt)
{
    if (lv_obj_check_type(obj, &lv_label_class) && !strcmp(lv_label_get_text(obj), txt) && lv_obj_is_visible(obj)) {
        lv_area_t a;
        lv_obj_get_coords(obj, &a);
        int dx = a.x1 + a.x2 + 1 - SIM_W, dy = a.y1 + a.y2 + 1 - SIM_H; /* centre of the box, doubled */
        int lit = 0;
        const uint16_t *fb = sim_fb();
        for (int y = a.y1; y <= a.y2; y++)
            for (int x = a.x1; x <= a.x2; x++) lit += fb[y * SIM_W + x] != 0;
        if (dx * dx + dy * dy < 4 * R * R && lit > 20) return true;
    }
    for (uint32_t i = 0; i < lv_obj_get_child_count(obj); i++)
        if (shows_text(lv_obj_get_child(obj, i), txt)) return true;
    return false;
}

/* Factory defaults (no name, no ICE contacts): the card shows the owner's phone and Telegram. */
static void test_ice_defaults(void)
{
    static owner_info_t o;
    owner_defaults(&o);
    CHECK(o.phone[0] && o.telegram[0]);
    post_owner(&o);
    post(UI_EV_COMBO_FIRE);
    check_inside("ice (defaults)");
    CHECK(shows_text(lv_screen_active(), o.phone));
    CHECK(shows_text(lv_screen_active(), o.telegram));
    CHECK(!shows_text(lv_screen_active(), "No emergency info set"));
    post(UI_EV_TOUCH);
}

static void test_max_length(void)
{
    static owner_info_t o;
    memset(&o, 0, sizeof o);
    fill_w(o.name, sizeof o.name);
    fill_w(o.phone, sizeof o.phone);
    fill_w(o.telegram, sizeof o.telegram);
    fill_w(o.qr_url, sizeof o.qr_url);
    fill_w(o.message, sizeof o.message);
    fill_w(o.med_note, sizeof o.med_note);
    for (int i = 0; i < 2; i++) {
        fill_w(o.ice_name[i], sizeof o.ice_name[i]);
        fill_w(o.ice_phone[i], sizeof o.ice_phone[i]);
    }
    post_owner(&o);

    check_inside("home");
    post_lost(1);
    check_inside("lost (max)");
    post(UI_EV_COMBO_FIRE);
    check_inside("ice (max)");
    post(UI_EV_TOUCH);
    post_lost(0);
    post_progress(99);
    check_inside("hold ring");
    post_progress(0);
}

int main(void)
{
    sim_init();
    test_flow();
    test_hold_ring();
    test_wifi_status();
    test_short_data();
    test_ice_defaults();
    test_max_length();
    return g_failed ? 1 : 0;
}
