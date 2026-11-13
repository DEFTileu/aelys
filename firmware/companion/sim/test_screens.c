/* Screens: screen switching through ui_handle_event(), and the pixel check that no text or
 * widget leaves the round 466 px display, even with every owner field at its maximum length. */
#define _POSIX_C_SOURCE 200809L /* setenv, tzset */
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "check.h"
#include "sim_display.h"
#include "snap_fixture.h"
#include "src/misc/lv_text_private.h" /* lv_text_encoded_next */
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

/* Contacts show their relation; the show bits hide the name, the contacts and the medical note independently. */
static void test_ice_relation_and_show_bits(void)
{
    static owner_info_t o;
    owner_defaults(&o);
    strcpy(o.name, "Alex Morgan");
    strcpy(o.ice_name[0], "Jamie Lee"); strcpy(o.ice_rel[0], "Sister"); strcpy(o.ice_phone[0], "+0 000 000 00 01");
    strcpy(o.ice_name[1], "Sam Rivera"); strcpy(o.ice_rel[1], "Doctor"); strcpy(o.ice_phone[1], "+0 000 000 00 02");
    strcpy(o.med_note, "Asthma");
    post_owner(&o);
    post(UI_EV_COMBO_FIRE);
    check_inside("ice (relations)");
    lv_obj_t *scr = lv_screen_active();
    CHECK(shows_text(scr, "Alex Morgan") && shows_text(scr, "Sister") && shows_text(scr, "Doctor"));
    CHECK(shows_text(scr, "Asthma") && shows_text(scr, "Jamie Lee"));

    o.show &= (uint8_t)~OWNER_SHOW_CONTACTS;
    post_owner(&o);
    sim_step(100);
    CHECK(!shows_text(scr, "Jamie Lee") && !shows_text(scr, "Sister"));
    CHECK(shows_text(scr, "Alex Morgan") && shows_text(scr, "Asthma"));

    o.show = OWNER_SHOW_CONTACTS;
    post_owner(&o);
    sim_step(100);
    CHECK(!shows_text(scr, "Alex Morgan") && !shows_text(scr, "Asthma"));
    CHECK(shows_text(scr, "Jamie Lee") && shows_text(scr, "Doctor"));
    post(UI_EV_TOUCH);
}

/* Lost mode: email shows, and a cleared show bit or QR_NONE removes the field / the QR. */
static void test_lost_fields_follow_show_bits(void)
{
    static owner_info_t o;
    owner_defaults(&o);
    strcpy(o.name, "Alex Morgan"); strcpy(o.email, "alex@example.com");
    post_owner(&o);
    post_lost(1);
    check_inside("lost (email)");
    lv_obj_t *scr = lv_screen_active();
    CHECK(shows_text(scr, "alex@example.com") && shows_text(scr, o.phone) && shows_text(scr, "Alex Morgan"));
    o.show &= (uint8_t)~(OWNER_SHOW_PHONE | OWNER_SHOW_EMAIL);
    post_owner(&o);
    sim_step(100);
    CHECK(!shows_text(scr, "alex@example.com") && !shows_text(scr, o.phone) && shows_text(scr, o.telegram));
    post_lost(0);
}

/* Every code point of every visible label has a real glyph in that label's font (no placeholder box). */
static int missing_glyphs(lv_obj_t *obj)
{
    int bad = 0;
    if (lv_obj_check_type(obj, &lv_label_class) && lv_obj_is_visible(obj)) {
        const lv_font_t *f = lv_obj_get_style_text_font(obj, LV_PART_MAIN);
        const char *t = lv_label_get_text(obj);
        for (uint32_t i = 0; t[i];) {
            uint32_t c = lv_text_encoded_next(t, &i);
            lv_font_glyph_dsc_t d;
            if (!lv_font_get_glyph_dsc(f, &d, c, 0)) {
                fprintf(stderr, "no glyph U+%04X in \"%s\"\n", (unsigned)c, t);
                bad++;
            }
        }
    }
    for (uint32_t i = 0; i < lv_obj_get_child_count(obj); i++) bad += missing_glyphs(lv_obj_get_child(obj, i));
    return bad;
}

static void test_cyrillic_and_kazakh_render(void)
{
    static owner_info_t o;
    owner_defaults(&o);
    strcpy(o.name, "\xD0\x90\xD0\xB9\xD0\xB3\xD0\xB5\xD1\x80\xD0\xB8\xD0\xBC \xD0\xA1\xD0\xB0\xD0\xBF\xD0\xB0\xD1\x80\xD0\xBE\xD0\xB2\xD0\xB0"); /* Айгерим Сапарова */
    strcpy(o.ice_name[0], "\xD3\x98\xD1\x81\xD0\xB5\xD0\xBC \xD2\x9A\xD2\xB1\xD1\x80\xD0\xBC\xD0\xB0\xD0\xBD\xD2\x93\xD0\xB0\xD0\xBB\xD0\xB8"); /* Әсем Құрманғали */
    strcpy(o.ice_rel[0], "\xD0\xA1\xD0\xB5\xD1\x81\xD1\x82\xD1\x80\xD0\xB0"); /* Сестра */
    strcpy(o.ice_phone[0], "+7 701 000 00 01");
    strcpy(o.ice_name[1], "\xD0\x90\xD0\xB9\xD0\xB3\xD0\xB5\xD1\x80\xD0\xB8\xD0\xBC \xD2\xA2\xD2\xAF\xD1\x80\xD0\xBA\xD1\x96"); /* Айгерим Ңүркі: Ң ү, plus Latin-look і (U+0456) */
    strcpy(o.ice_rel[1], "\xD0\x90\xD2\x93\xD0\xB0");   /* Аға */
    strcpy(o.ice_phone[1], "+7 701 000 00 02");
    strcpy(o.med_note, "\xD0\x90\xD0\xBB\xD0\xBB\xD0\xB5\xD1\x80\xD0\xB3\xD0\xB8\xD1\x8F: \xD0\xBF\xD0\xB5\xD0\xBD\xD0\xB8\xD1\x86\xD0\xB8\xD0\xBB\xD0\xBB\xD0\xB8\xD0\xBD"); /* Аллергия: пенициллин */
    strcpy(o.message, "\xD0\x95\xD1\x81\xD0\xBB\xD0\xB8 \xD0\xBD\xD0\xB0\xD1\x88\xD0\xBB\xD0\xB8, \xD0\xBF\xD0\xBE\xD0\xB7\xD0\xB2\xD0\xBE\xD0\xBD\xD0\xB8\xD1\x82\xD0\xB5"); /* Если нашли, позвоните */
    post_owner(&o);
    post_lost(1);
    check_inside("lost (cyrillic)");
    CHECK(shows_text(lv_screen_active(), o.name));
    CHECK_EQ(missing_glyphs(lv_screen_active()), 0);
    post(UI_EV_COMBO_FIRE);
    check_inside("ice (cyrillic)");
    CHECK(shows_text(lv_screen_active(), o.ice_name[0]));
    CHECK(shows_text(lv_screen_active(), o.ice_rel[0]));
    CHECK_EQ(missing_glyphs(lv_screen_active()), 0);
    post(UI_EV_TOUCH);
    post_lost(0);
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
    fill_w(o.email, sizeof o.email);
    for (int i = 0; i < 2; i++) {
        fill_w(o.ice_name[i], sizeof o.ice_name[i]);
        fill_w(o.ice_rel[i], sizeof o.ice_rel[i]);
        fill_w(o.ice_phone[i], sizeof o.ice_phone[i]);
    }
    o.show = 0x3F; /* everything visible */
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

static void post_pair(uint8_t state, const char *digits)
{
    uint8_t d[7] = { state };
    if (digits) memcpy(d + 1, digits, 6);
    sim_post(UI_EV_PAIR, d, sizeof d);
}

/* A paired home with no tasks yet has no "Not paired yet" line. */
static void test_home_paired_line(void)
{
    lv_obj_t *scr = lv_screen_active();
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    CHECK(shows_text(scr, "Not paired yet"));
    uint8_t offline = LINK_UI_OFFLINE;
    sim_post(UI_EV_LINK, &offline, 1);                       /* boot of a paired board */
    sim_step(100);
    CHECK(!shows_text(scr, "Not paired yet") && !shows_text(scr, "Hi, I'm Aelys"));
    check_inside("home paired");
}

/* The code screen shows the six digits inside the circle; "Paired" shows for 2 s, then home. */
static void test_pair_screen_shot(void)
{
    lv_obj_t *scr = lv_screen_active();
    post_pair(PAIR_UI_CODE, "482913");
    CHECK_EQ(ui_current_screen(), SCR_PAIR);
    check_inside("pair code");
    CHECK(shows_text(scr, "482913"));
    CHECK(shows_text(scr, "Pair with Aelys"));
    CHECK(shows_text(scr, "Confirm this code in Aelys web"));
    CHECK(!shows_text(scr, "Both codes must match"));
    CHECK_EQ(missing_glyphs(scr), 0);
    post_pair(PAIR_UI_CODE, "12x456");                      /* not digits: ignored, old code stays */
    CHECK(shows_text(scr, "482913"));

    post_pair(PAIR_UI_DONE, NULL);
    CHECK_EQ(ui_current_screen(), SCR_PAIR);
    check_inside("pair done");
    CHECK(shows_text(scr, "Paired") && shows_text(scr, "Syncing your day"));
    CHECK(!shows_text(scr, "482913"));
    sim_step(1700);
    CHECK_EQ(ui_current_screen(), SCR_PAIR);
    sim_step(300);
    CHECK_EQ(ui_current_screen(), SCR_HOME);

    post_pair(PAIR_UI_CODE, "000000");
    post_pair(PAIR_UI_HIDE, NULL);
    CHECK_EQ(ui_current_screen(), SCR_HOME);

    post_pair(PAIR_UI_CODE, "000000");                      /* lost mode takes the screen over */
    post_lost(1);
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    post_pair(PAIR_UI_CODE, "111111");
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    post_lost(0);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
}

/* First boot (unpaired, no Wi-Fi): home shows the welcome, and pairing clears it. */
static void test_first_boot_welcome(void)
{
    lv_obj_t *scr = lv_screen_active();
    uint8_t unpaired = LINK_UI_UNPAIRED, online = LINK_UI_ONLINE;
    CHECK(!shows_text(scr, "Hi, I'm Aelys"));
    sim_post(UI_EV_LINK, &unpaired, 1);
    check_inside("home welcome");
    CHECK(shows_text(scr, "Hi, I'm Aelys") && shows_text(scr, "Connect me by USB and open Aelys web"));
    sim_post(UI_EV_LINK, &online, 1);
    sim_step(100);
    CHECK(!shows_text(scr, "Hi, I'm Aelys"));
    sim_post(UI_EV_LINK, &unpaired, 1);
    post_pair(PAIR_UI_DONE, NULL);
    sim_step(2100);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    CHECK(!shows_text(scr, "Hi, I'm Aelys") && !shows_text(scr, "Not paired yet")); /* paired, no tasks yet */
}

/* ---- companion screens: Today, Aelys offline, Focus, Inbox, actions ---- */

static lv_obj_t *find_label(lv_obj_t *obj, const char *txt)
{
    if (lv_obj_check_type(obj, &lv_label_class) && !strcmp(lv_label_get_text(obj), txt) && lv_obj_is_visible(obj)) return obj;
    for (uint32_t i = 0; i < lv_obj_get_child_count(obj); i++) {
        lv_obj_t *f = find_label(lv_obj_get_child(obj, i), txt);
        if (f) return f;
    }
    return NULL;
}

/* LVGL cuts an over-long label in place and ends it with "...": the first visible label that does */
static lv_obj_t *find_dotted(lv_obj_t *obj)
{
    if (lv_obj_check_type(obj, &lv_label_class) && lv_obj_is_visible(obj)) {
        const char *t = lv_label_get_text(obj);
        size_t n = strlen(t);
        if (n > 3 && !strcmp(t + n - 3, "...")) return obj;
    }
    for (uint32_t i = 0; i < lv_obj_get_child_count(obj); i++) {
        lv_obj_t *f = find_dotted(lv_obj_get_child(obj, i));
        if (f) return f;
    }
    return NULL;
}

static void touch_at(int x, int y)
{
    uint8_t d[4] = { (uint8_t)x, (uint8_t)(x >> 8), (uint8_t)y, (uint8_t)(y >> 8) };
    sim_post(UI_EV_TOUCH, d, 4);
}

/* what the input task posts for a tap / a swipe: TOUCH at the down, the gesture at the lift, then RELEASE */
static void tap_at(int x, int y)
{
    uint8_t d[4] = { (uint8_t)x, (uint8_t)(x >> 8), (uint8_t)y, (uint8_t)(y >> 8) };
    touch_at(x, y);
    sim_post(UI_EV_TAP, d, 4);
    post(UI_EV_RELEASE);
}

static void tap_label(const char *txt)
{
    lv_obj_t *l = find_label(lv_screen_active(), txt);
    CHECK(l != NULL);
    if (!l) return;
    lv_area_t a;
    lv_obj_get_coords(l, &a);
    tap_at((a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2);
}

static void swipe(uint8_t type)
{
    touch_at(233, 233);
    post(type);
    post(UI_EV_RELEASE);
}

static void btn(ui_btn_t b) { uint8_t v = (uint8_t)b; sim_post(UI_EV_BTN, &v, 1); }
static void link_state(uint8_t st) { sim_post(UI_EV_LINK, &st, 1); }

static struct { int n; act_kind_t kind; char id[40]; bool accept; } sink;
static bool test_sink(act_kind_t k, const char *id)
{
    if (!sink.accept) return false;
    sink.n++;
    sink.kind = k;
    snprintf(sink.id, sizeof sink.id, "%s", id ? id : "");
    return true;
}

static void action_result(act_kind_t k, bool ok, const char *err)
{
    uint8_t d[26] = { (uint8_t)k, ok };
    if (err) strncpy((char *)d + 2, err, 23);
    sim_post(UI_EV_ACTION, d, sizeof d);
}

static snap_t fx;
static void post_fx(void) { fx_post(&fx, 1); sim_step(100); }
static void fresh_fx(void) { fx_snap(&fx); post_fx(); }

static void test_companion_setup(void)
{
    setenv("TZ", "UTC", 1);
    tzset();
    ui_set_clock(fx_clock);
    ui_set_action_sink(test_sink);
    sink.accept = true;
    uint8_t hm[2] = { 14, 32 };
    sim_post(UI_EV_TIME, hm, 2);
    link_state(LINK_UI_ONLINE);
    fresh_fx();
}

static void test_today_shot(void)
{
    lv_obj_t *scr = lv_screen_active();
    swipe(UI_EV_SWIPE_RIGHT);
    CHECK_EQ(ui_current_screen(), SCR_TODAY);
    check_inside("today");
    CHECK(shows_text(scr, "Thu, Nov 12") && shows_text(scr, "14:32"));
    CHECK(shows_text(scr, "Ship pairing ADR") && shows_text(scr, "18:00"));
    CHECK(shows_text(scr, "Design review") && shows_text(scr, "16:00"));
    CHECK(shows_text(scr, "3 new") && shows_text(scr, "5 / 8 done"));
    CHECK_EQ(missing_glyphs(scr), 0);

    fx.today_total = fx.today_done = -1;            /* server v1: no progress, no ring */
    fx.has_event = false;
    post_fx();
    check_inside("today (v1)");
    CHECK(!shows_text(scr, "5 / 8 done") && !shows_text(scr, "-1 / -1 done") && !shows_text(scr, "Design review"));
    CHECK(shows_text(scr, "3 new"));

    fx_snap(&fx);                                    /* a long Cyrillic title is cut with "..." inside the circle */
    strcpy(fx.task.title, "\xD0\x9F\xD0\xBE\xD0\xB4\xD0\xB3\xD0\xBE\xD1\x82\xD0\xBE\xD0\xB2\xD0\xB8\xD1\x82\xD1\x8C \xD0\xBE\xD1\x82\xD1\x87\xD1\x91\xD1\x82 \xD0\xBF\xD0\xBE \xD0\xBF\xD1\x80\xD0\xBE\xD0\xB5\xD0\xBA\xD1\x82\xD1\x83 Q4 ABC");
    post_fx();
    check_inside("today (long cyrillic)");
    lv_obj_t *t = find_dotted(scr);
    CHECK(t != NULL);
    if (t) {
        lv_point_t sz;
        lv_text_get_size(&sz, fx.task.title, lv_obj_get_style_text_font(t, 0), 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
        CHECK(sz.x > lv_obj_get_width(t));           /* too long for the box, and it ends in "..." */
    }
    CHECK_EQ(missing_glyphs(scr), 0);
    fresh_fx();
    swipe(UI_EV_SWIPE_LEFT);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
}

static void test_tap_sends_task_complete(void)
{
    lv_obj_t *scr = lv_screen_active();
    swipe(UI_EV_SWIPE_RIGHT);
    sink.n = 0;
    tap_label("Ship pairing ADR");
    CHECK_EQ(sink.n, 1);
    CHECK_EQ(sink.kind, ACT_TASK_COMPLETE);
    CHECK(!strcmp(sink.id, "t-101"));
    tap_label("Ship pairing ADR");                   /* already ticked: not sent twice */
    CHECK_EQ(sink.n, 1);
    action_result(ACT_TASK_COMPLETE, false, "TIMEOUT");
    sim_step(100);
    CHECK(shows_text(scr, "Didn't work \xE2\x80\x94 try again"));
    sim_step(1800);
    CHECK(shows_text(scr, "Didn't work \xE2\x80\x94 try again"));
    sim_step(300);
    CHECK(!shows_text(scr, "Didn't work \xE2\x80\x94 try again")); /* gone after 2 s */
    tap_label("Ship pairing ADR");                   /* the tick was taken back: can be sent again */
    CHECK_EQ(sink.n, 2);

    action_result(ACT_TASK_COMPLETE, false, "TIMEOUT");
    sim_step(2100);
    sink.accept = false;                             /* no pairing / offline: "No connection" at once */
    tap_label("Ship pairing ADR");
    sim_step(100);
    CHECK(shows_text(scr, "No connection"));
    check_inside("today (toast)");
    sink.accept = true;
    action_result(ACT_FOCUS_START, false, "OFFLINE");
    sim_step(100);
    CHECK(shows_text(scr, "No connection"));
    sim_step(2100);

    /* the "{n} new" row opens the inbox; the circle row does not */
    sink.n = 0;
    tap_label("3 new");
    CHECK_EQ(ui_current_screen(), SCR_INBOX);
    CHECK_EQ(sink.n, 0);
    btn(BTN_LOW);
    CHECK_EQ(ui_current_screen(), SCR_TODAY);
    swipe(UI_EV_SWIPE_LEFT);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
}

static void test_inbox_shot(void)
{
    lv_obj_t *scr = lv_screen_active();
    swipe(UI_EV_SWIPE_RIGHT);
    tap_label("3 new");
    CHECK_EQ(ui_current_screen(), SCR_INBOX);
    check_inside("inbox");
    CHECK(shows_text(scr, "Inbox \xC2\xB7 3") && shows_text(scr, "+2 from other apps"));
    CHECK(shows_text(scr, "Tasks \xC2\xB7 now") && shows_text(scr, "Calendar \xC2\xB7 15 min ago") &&
          shows_text(scr, "Focus \xC2\xB7 20 min ago"));
    CHECK_EQ(missing_glyphs(scr), 0);
    sink.n = 0;
    tap_label("Design review");
    CHECK_EQ(sink.n, 1);
    CHECK_EQ(sink.kind, ACT_NOTIFICATION_READ);
    CHECK(!strcmp(sink.id, "n-2"));
    tap_label("Design review");
    CHECK_EQ(sink.n, 1);                             /* ticked: once */
    action_result(ACT_NOTIFICATION_READ, true, NULL);
    CHECK_EQ(ui_current_screen(), SCR_INBOX);
    swipe(UI_EV_SWIPE_RIGHT);
    CHECK_EQ(ui_current_screen(), SCR_INBOX);        /* swipes do nothing here */
    tap_at(233, 436);                                /* below the rows */
    CHECK_EQ(ui_current_screen(), SCR_TODAY);

    tap_label("3 new");
    sim_step(14000);
    CHECK_EQ(ui_current_screen(), SCR_INBOX);
    tap_label("Session done");                       /* a touch restarts the 15 s */
    action_result(ACT_NOTIFICATION_READ, true, NULL);
    sim_step(14000);
    CHECK_EQ(ui_current_screen(), SCR_INBOX);
    sim_step(1100);
    CHECK_EQ(ui_current_screen(), SCR_TODAY);        /* timeout */

    fx_snap(&fx);                                    /* five rows with long Cyrillic titles, v1 server */
    fx.n_notices = 5;
    fx.other_unread = -1;
    fx.unread = 5;
    for (int i = 0; i < 5; i++) {
        char id[8];
        snprintf(id, sizeof id, "n-%d", i);
        fx_notice(&fx.notices[i], id, i % 2 ? "calendar.reminder" : "task.reminder",
                  "\xD0\x9F\xD0\xBE\xD0\xB4\xD0\xB3\xD0\xBE\xD1\x82\xD0\xBE\xD0\xB2\xD0\xB8\xD1\x82\xD1\x8C \xD0\xBE\xD1\x82\xD1\x87\xD1\x91\xD1\x82 \xD0\xBF\xD0\xBE \xD0\xBF\xD1\x80\xD0\xBE\xD0\xB5\xD0\xBA\xD1\x82\xD1\x83 Q4 ABC",
                  FX_NOW - 3600 * (i + 1));
    }
    post_fx();
    tap_label("5 new");
    CHECK_EQ(ui_current_screen(), SCR_INBOX);
    check_inside("inbox (5 long rows)");
    CHECK(shows_text(scr, "Tasks \xC2\xB7 1 h ago") && shows_text(scr, "Calendar \xC2\xB7 2 h ago"));
    CHECK(!shows_text(scr, "from other apps"));      /* v1: hidden */
    CHECK_EQ(missing_glyphs(scr), 0);
    btn(BTN_LOW);
    swipe(UI_EV_SWIPE_LEFT);
    fresh_fx();
}

static void test_offline_shot(void)
{
    lv_obj_t *scr = lv_screen_active();
    CHECK(!shows_text(scr, "Offline"));
    link_state(LINK_UI_OFFLINE);
    sim_step(100);
    check_inside("offline");
    CHECK(shows_text(scr, "Offline") && shows_text(scr, "Showing data from 14:05"));
    CHECK(shows_text(scr, "5 / 8 tasks \xC2\xB7 next at 16:00"));
    CHECK(!shows_text(scr, "3 left today"));
    CHECK_EQ(missing_glyphs(scr), 0);
    /* the Wi-Fi line is not lost on this view: a failing Wi-Fi is exactly when the board is offline */
    uint8_t w = UI_WIFI_BAD_PASSWORD;
    sim_post(UI_EV_WIFI, &w, 1);
    sim_step(100);
    check_inside("offline (bad password)");
    CHECK(shows_text(scr, "Wrong Wi-Fi password") && shows_text(scr, "Offline") && shows_text(scr, "Showing data from 14:05"));
    w = UI_WIFI_CONNECTING;
    sim_post(UI_EV_WIFI, &w, 1);
    sim_step(100);
    check_inside("offline (connecting)");
    CHECK(shows_text(scr, "Connecting..."));
    w = UI_WIFI_ONLINE;                              /* "Online" under "Offline" would only confuse */
    sim_post(UI_EV_WIFI, &w, 1);
    sim_step(100);
    CHECK(!shows_text(scr, "Online"));
    w = UI_WIFI_OFFLINE;
    sim_post(UI_EV_WIFI, &w, 1);
    sim_step(100);
    CHECK(!shows_text(scr, "Connecting...") && !shows_text(scr, "Wrong Wi-Fi password"));
    w = UI_WIFI_BAD_PASSWORD;                        /* and it is back on the normal home */
    sim_post(UI_EV_WIFI, &w, 1);
    link_state(LINK_UI_CONNECTING);
    sim_step(100);
    CHECK(shows_text(scr, "Wrong Wi-Fi password") && shows_text(scr, "3 left today") && !shows_text(scr, "Showing data from 14:05"));
    w = UI_WIFI_OFFLINE;
    sim_post(UI_EV_WIFI, &w, 1);
    CHECK(shows_text(scr, "3 left today"));
    memset(&fx, 0, sizeof fx);                       /* offline with nothing cached: just "Offline" */
    fx.today_total = -1;
    post_fx();
    link_state(LINK_UI_OFFLINE);
    sim_step(100);
    check_inside("offline (no data)");
    CHECK(shows_text(scr, "Offline") && !shows_text(scr, "Showing data from --:--"));
    link_state(LINK_UI_ONLINE);
    fresh_fx();
}

static void focus_snap(uint8_t status, const char *mode, int elapsed)
{
    fx_snap(&fx);
    fx.focus.status = status;
    strcpy(fx.focus.id, "f-3");
    strcpy(fx.focus.mode, mode);
    fx.focus.elapsed_s = elapsed;
    post_fx();
}

static void test_focus_shots(void)
{
    lv_obj_t *scr = lv_screen_active();
    swipe(UI_EV_SWIPE_LEFT);
    CHECK_EQ(ui_current_screen(), SCR_FOCUS);
    check_inside("focus (none)");
    CHECK(shows_text(scr, "Focus \xC2\xB7 25 min session") && shows_text(scr, "Start"));
    sink.n = 0;
    tap_at(233, 300);                                /* a tap starts */
    CHECK_EQ(sink.n, 1);
    CHECK_EQ(sink.kind, ACT_FOCUS_START);
    sink.n = 0;
    btn(BTN_TOP);                                    /* so does the top key */
    CHECK_EQ(sink.n, 1);
    CHECK_EQ(sink.kind, ACT_FOCUS_START);

    focus_snap(FOCUS_ACTIVE, "pomodoro", 545);       /* 9:05 elapsed -> 15:55 left */
    check_inside("focus (active)");
    CHECK(shows_text(scr, "15:55") && shows_text(scr, "Pause") && shows_text(scr, "Focus"));
    sim_step(5000);
    CHECK(shows_text(scr, "15:50"));                 /* seconds since the snapshot arrived are added */
    sink.n = 0;
    tap_at(233, 300);                                /* a tap does not pause */
    CHECK_EQ(sink.n, 0);
    btn(BTN_TOP);
    CHECK_EQ(sink.kind, ACT_FOCUS_PAUSE);

    focus_snap(FOCUS_PAUSED, "pomodoro", 1072);      /* 17:52 elapsed -> 07:08 */
    sim_step(5000);
    check_inside("focus (paused)");
    CHECK(shows_text(scr, "07:08") && shows_text(scr, "Paused") && shows_text(scr, "Resume") && shows_text(scr, "Hold to stop"));
    btn(BTN_TOP);
    CHECK_EQ(sink.kind, ACT_FOCUS_RESUME);
    sink.n = 0;
    touch_at(233, 233);                              /* hold 800 ms: stop */
    sim_step(790);
    CHECK_EQ(sink.n, 0);
    sim_step(30);
    CHECK_EQ(sink.n, 1);
    CHECK_EQ(sink.kind, ACT_FOCUS_STOP);
    post(UI_EV_RELEASE);
    sink.n = 0;
    touch_at(233, 233);                              /* lifted at 500 ms: nothing */
    sim_step(500);
    post(UI_EV_RELEASE);
    sim_step(1000);
    CHECK_EQ(sink.n, 0);
    touch_at(233, 233);                              /* a swipe cancels it too */
    sim_step(300);
    post(UI_EV_SWIPE_LEFT);
    post(UI_EV_RELEASE);
    sim_step(1000);
    CHECK_EQ(sink.n, 0);
    CHECK_EQ(ui_current_screen(), SCR_FOCUS);        /* (no swipe left from Focus) */

    focus_snap(FOCUS_ACTIVE, "pomodoro", 1495);      /* 5 s left, then done */
    CHECK(shows_text(scr, "00:05"));
    sim_step(5000);
    check_inside("focus (done)");
    CHECK(shows_text(scr, "Session done") && shows_text(scr, "Done") && shows_text(scr, "25 min"));
    CHECK_EQ(missing_glyphs(scr), 0);
    btn(BTN_TOP);
    CHECK_EQ(sink.kind, ACT_FOCUS_STOP);

    focus_snap(FOCUS_ACTIVE, "stopwatch", 3725);     /* counts up, no ring */
    CHECK(shows_text(scr, "62:05") && shows_text(scr, "Pause"));
    sim_step(3000);
    CHECK(shows_text(scr, "62:08"));
    check_inside("focus (stopwatch)");

    btn(BTN_LOW);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    fresh_fx();
}

static void test_failed_read_clears_only_that_notice(void)
{
    fx_snap(&fx);                                    /* drops the ticks left by earlier tests */
    fx.n_notices = 0;
    post_fx();
    fresh_fx();
    swipe(UI_EV_SWIPE_RIGHT);
    tap_label("3 new");
    sink.n = 0;
    tap_label("Ship pairing ADR");
    tap_label("Design review");
    CHECK_EQ(sink.n, 2);
    action_result(ACT_NOTIFICATION_READ, false, "TIMEOUT");   /* the answer to the first read */
    sim_step(100);
    tap_label("Design review");
    CHECK_EQ(sink.n, 2);                             /* still ticked */
    tap_label("Ship pairing ADR");
    CHECK_EQ(sink.n, 3);                             /* its tick was taken back: sent again */
    CHECK(!strcmp(sink.id, "n-1"));
    action_result(ACT_NOTIFICATION_READ, true, NULL);
    action_result(ACT_NOTIFICATION_READ, true, NULL);
    btn(BTN_LOW);
    swipe(UI_EV_SWIPE_LEFT);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
}

/* "Session done" closes the ring: no gap at 12 o'clock (it was a 1 degree notch) */
static void test_done_ring_is_closed(void)
{
    const uint16_t *fb = sim_fb();
    swipe(UI_EV_SWIPE_LEFT);
    focus_snap(FOCUS_ACTIVE, "pomodoro", 1500);
    sim_step(1100);
    CHECK(shows_text(lv_screen_active(), "Session done"));
    for (int x = 229; x <= 237; x++) CHECK(((fb[14 * SIM_W + x] >> 11) & 31) > 20); /* coral across the top */
    fresh_fx();
    swipe(UI_EV_SWIPE_RIGHT);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
}

/* The once-a-second refresh must not redraw anything while nothing changes (idle fps stays as it was). */
static void test_idle_screens_do_not_redraw(void)
{
    swipe(UI_EV_SWIPE_RIGHT);                        /* Today: no animation on it */
    sim_step(1000);
    uint32_t n = sim_flushes();
    sim_step(1000); sim_step(1000); sim_step(1000);
    CHECK_EQ(sim_flushes(), n);
    tap_label("3 new");                              /* Inbox */
    sim_step(1000);
    n = sim_flushes();
    sim_step(1000); sim_step(1000); sim_step(1000);
    CHECK_EQ(sim_flushes(), n);
    btn(BTN_LOW);
    swipe(UI_EV_SWIPE_LEFT);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
}

static void test_gestures_and_lost_mode(void)
{
    swipe(UI_EV_SWIPE_RIGHT);
    CHECK_EQ(ui_current_screen(), SCR_TODAY);
    const char *oops = "Didn't work \xE2\x80\x94 try again";
    action_result(ACT_FOCUS_START, false, "TIMEOUT");
    sim_step(100);
    CHECK(shows_text(lv_screen_active(), oops));
    post_lost(1);                                    /* a toast already up goes at once ... */
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    CHECK(!shows_text(lv_screen_active(), oops));
    sink.n = 0;
    swipe(UI_EV_SWIPE_RIGHT);
    swipe(UI_EV_SWIPE_LEFT);
    tap_at(233, 237);
    btn(BTN_TOP);
    btn(BTN_LOW);
    action_result(ACT_TASK_COMPLETE, false, "TIMEOUT");
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    CHECK_EQ(sink.n, 0);
    check_inside("lost (events ignored)");
    CHECK(!shows_text(lv_screen_active(), "Didn't work \xE2\x80\x94 try again"));
    post_lost(0);
    CHECK_EQ(ui_current_screen(), SCR_HOME);

    /* ... and none starts over the ICE card or the pairing screen */
    action_result(ACT_FOCUS_START, false, "TIMEOUT");
    post(UI_EV_COMBO_FIRE);
    sim_step(100);
    CHECK(!shows_text(lv_screen_active(), oops));
    action_result(ACT_FOCUS_START, false, "TIMEOUT");
    sim_step(100);
    CHECK(!shows_text(lv_screen_active(), oops));
    post(UI_EV_TOUCH);
    post_pair(PAIR_UI_CODE, "123456");
    action_result(ACT_FOCUS_START, false, "OFFLINE");
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_PAIR);
    CHECK(!shows_text(lv_screen_active(), oops) && !shows_text(lv_screen_active(), "No connection"));
    post_pair(PAIR_UI_HIDE, NULL);
    sim_step(2100);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    CHECK(!shows_text(lv_screen_active(), oops));    /* nothing comes back when the screen does */

    post(UI_EV_COMBO_FIRE);                          /* the touch that closes the ICE card is not a swipe on home */
    touch_at(233, 233);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    post(UI_EV_SWIPE_RIGHT);
    post(UI_EV_RELEASE);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    swipe(UI_EV_SWIPE_RIGHT);                        /* a fresh touch does */
    CHECK_EQ(ui_current_screen(), SCR_TODAY);
    swipe(UI_EV_SWIPE_LEFT);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
}

/* Design "Режим потери · нажата кнопка": a key or a touch on the lost screen leaves lost mode alone and shows the hint for 2 s. */
static void test_lost_hint_toast_shot(void)
{
    lv_obj_t *scr = lv_screen_active();
    const char *hint = "Only the owner can turn this off";
    post_lost(1);
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    CHECK(!shows_text(scr, hint));
    btn(BTN_LOW);
    sim_step(100);
    CHECK(shows_text(scr, hint));
    check_inside("lost hint");
    CHECK_EQ(missing_glyphs(scr), 0);
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    sim_step(1700);
    CHECK(shows_text(scr, hint));                    /* 1.9 s */
    sim_step(300);
    CHECK(!shows_text(scr, hint));                   /* gone after 2 s */

    tap_at(233, 237);                                /* a tap, then a swipe, then the top key each bring it back */
    sim_step(100);
    CHECK(shows_text(scr, hint));
    sim_step(1500);
    swipe(UI_EV_SWIPE_LEFT);                         /* restarts the 2 s */
    sim_step(1500);
    CHECK(shows_text(scr, hint));
    sim_step(600);
    CHECK(!shows_text(scr, hint));
    btn(BTN_TOP);
    sim_step(100);
    CHECK(shows_text(scr, hint));
    CHECK_EQ(ui_current_screen(), SCR_LOST);

    post(UI_EV_COMBO_FIRE);                          /* the ICE card is not lost mode's to guard: no hint over it, */
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_ICE);
    CHECK(!shows_text(scr, hint));
    tap_at(233, 233);                                /* and the touch that closes it is not a tap on the lost screen */
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    CHECK(!shows_text(scr, hint));
    post_lost(0);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    CHECK(!shows_text(scr, hint));
}

/* UI_EV_WIFI_ADD: [0] state, [1..33] SSID, [34..59] previous SSID */
static void wifi_add_ev(uint8_t state, const char *ssid, const char *prev)
{
    uint8_t d[60] = { state };
    strncpy((char *)&d[1], ssid, 32);
    strncpy((char *)&d[34], prev, 25);
    sim_post(UI_EV_WIFI_ADD, d, sizeof d);
}

/* Designs "Wi-Fi с телефона" and "Wi-Fi · неверный пароль": a card on top of the everyday screens, never over lost mode, the
 * ICE card or the pairing screen. A 32-character SSID still fits the circle. */
static void test_wifi_toast_shots(void)
{
    lv_obj_t *scr = lv_screen_active();
    char wide[33];
    memset(wide, 'W', 32);
    wide[32] = '\0';

    wifi_add_ev(0, "Office", "Home");
    sim_step(100);
    check_inside("wifi connecting");
    CHECK(shows_text(scr, "New Wi-Fi from phone") && shows_text(scr, "Office") && shows_text(scr, "Connecting\xE2\x80\xA6"));
    CHECK_EQ(missing_glyphs(scr), 0);
    sim_step(5000);
    CHECK(shows_text(scr, "Connecting\xE2\x80\xA6"));          /* waits for the answer, not for a timer */
    wifi_add_ev(1, "Office", "Home");
    sim_step(100);
    check_inside("wifi connected");
    CHECK(shows_text(scr, "Connected") && shows_text(scr, "Office") && !shows_text(scr, "Connecting\xE2\x80\xA6"));
    CHECK(!shows_text(scr, "New Wi-Fi from phone"));
    sim_step(2100);
    CHECK(!shows_text(scr, "Connected") && !shows_text(scr, "Office")); /* gone after 2 s */

    wifi_add_ev(0, wide, "");
    sim_step(100);
    check_inside("wifi connecting (32 chars)");
    wifi_add_ev(2, wide, "Home");
    sim_step(100);
    check_inside("wifi wrong password (32 chars)");
    CHECK(shows_text(scr, "Wrong password") && shows_text(scr, "still on Home") && shows_text(scr, "Fix it in Aelys on your phone"));
    CHECK_EQ(missing_glyphs(scr), 0);
    sim_step(4000);
    CHECK(shows_text(scr, "Wrong password"));                    /* long enough to read */
    sim_step(1200);
    CHECK(!shows_text(scr, "Wrong password"));

    wifi_add_ev(2, "Office", "");                                /* no previous network: no "still on" line */
    sim_step(100);
    check_inside("wifi wrong password (offline before)");
    CHECK(shows_text(scr, "Wrong password") && shows_text(scr, "Office") && !shows_text(scr, "still on Home"));
    wifi_add_ev(0, "Cafe", "");                                  /* a new attempt replaces the card */
    sim_step(100);
    CHECK(!shows_text(scr, "Wrong password") && shows_text(scr, "Cafe"));

    uint8_t short_ev[2] = { 1, 'X' };                            /* a short event is cut safely: no crash, still inside the circle */
    sim_post(UI_EV_WIFI_ADD, short_ev, 0);
    sim_post(UI_EV_WIFI_ADD, short_ev, 2);
    sim_step(100);
    check_inside("wifi short event");
    wifi_add_ev(3, "", "");                                      /* "never ran": the card goes at once */
    sim_step(100);
    CHECK(!shows_text(scr, "Cafe") && !shows_text(scr, "Connecting\xE2\x80\xA6"));
    wifi_add_ev(0, "Cafe", "");
    sim_step(100);
    CHECK(shows_text(scr, "Cafe"));
    uint8_t bad[60] = { 9, 'Z' };                                /* unknown state: ignored */
    sim_post(UI_EV_WIFI_ADD, bad, sizeof bad);
    sim_step(2200);

    /* lost mode, the ICE card and the pairing screen: nothing shows (the command still runs on the board) */
    post_lost(1);
    sim_step(100);
    wifi_add_ev(0, "Office", "Home");
    sim_step(100);
    CHECK(!shows_text(scr, "New Wi-Fi from phone") && !shows_text(scr, "Office"));
    wifi_add_ev(2, "Office", "Home");
    sim_step(100);
    CHECK(!shows_text(scr, "Wrong password"));
    post(UI_EV_COMBO_FIRE);
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_ICE);
    wifi_add_ev(2, "Office", "Home");
    sim_step(100);
    CHECK(!shows_text(scr, "Wrong password"));
    post(UI_EV_TOUCH);
    post_lost(0);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    wifi_add_ev(0, "Office", "Home");                            /* shown, then lost mode takes it off at once */
    sim_step(100);
    CHECK(shows_text(scr, "Office"));
    post_lost(1);
    sim_step(100);
    CHECK(!shows_text(scr, "Office") && !shows_text(scr, "New Wi-Fi from phone"));
    post_lost(0);
    sim_step(100);
    CHECK(!shows_text(scr, "Office"));                           /* and it does not come back */
    const uint8_t code[7] = { PAIR_UI_CODE, '4', '8', '2', '9', '1', '3' };
    sim_post(UI_EV_PAIR, code, sizeof code);
    wifi_add_ev(1, "Office", "");
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_PAIR);
    CHECK(!shows_text(scr, "Connected"));
    const uint8_t hide = PAIR_UI_HIDE;
    sim_post(UI_EV_PAIR, &hide, 1);
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
}

/* UI_EV_FIND ([0] = 1 start / 0 stop): design "Найти Элис". An overlay of its own on top of any screen, never a screen change. */
static void find_ev(int on) { uint8_t v = (uint8_t)on; sim_post(UI_EV_FIND, &v, 1); }
static int find_stops;
static void count_find_stop(void) { find_stops++; }

static int ring_red(void) { return (sim_fb()[13 * SIM_W + 233] >> 11) & 31; } /* the ring's top, 5-bit red */

static void test_find_overlay_shot(void)
{
    lv_obj_t *scr = lv_screen_active();
    const char *title = "Here I am!", *sub = "Playing sound \xC2\xB7 tap to stop";
    ui_set_find_stop(count_find_stop);
    fresh_fx();
    swipe(UI_EV_SWIPE_RIGHT);                         /* Today: the one screen with no animation of its own */
    CHECK_EQ(ui_current_screen(), SCR_TODAY);
    CHECK(!shows_text(scr, title));

    find_ev(1);
    sim_step(100);
    CHECK(shows_text(scr, title) && shows_text(scr, sub));
    CHECK_EQ(missing_glyphs(scr), 0);
    check_inside("find overlay");
    CHECK_EQ(ui_current_screen(), SCR_TODAY);          /* not a screen: the one below stays */
    CHECK(ring_red() > 20);                           /* the lit ring ... */
    sim_step(200);
    CHECK(ring_red() < 8);                            /* ... flashes dim after 250 ms ... */
    sim_step(300);
    CHECK(ring_red() > 20);                           /* ... and back every 500 ms */
    uint32_t n = sim_flushes();
    sim_step(1000);
    CHECK(sim_flushes() > n);                         /* the ripples and the ring keep moving */
    check_inside("find overlay (ripples)");

    /* a toast or the Wi-Fi card does not show through it, and does not come back afterwards */
    action_result(ACT_FOCUS_START, false, "TIMEOUT");
    wifi_add_ev(0, "Office", "Home");
    sim_step(100);
    CHECK(!shows_text(scr, "Office") && !shows_text(scr, "Didn't work \xE2\x80\x94 try again"));

    /* the end of the sound (60 s cap, or an error) comes as FIND(0) and does not call the stop hook */
    find_ev(0);
    sim_step(100);
    CHECK(!shows_text(scr, title) && !shows_text(scr, sub));
    CHECK(!shows_text(scr, "Office") && !shows_text(scr, "Didn't work \xE2\x80\x94 try again")); /* and neither waited behind it */
    CHECK_EQ(find_stops, 0);
    CHECK_EQ(ui_current_screen(), SCR_TODAY);
    sim_step(1000);
    uint32_t idle = sim_flushes();
    sim_step(1000); sim_step(1000); sim_step(1000);
    CHECK_EQ(sim_flushes(), idle);                    /* nothing keeps animating once it is gone */

    /* a tap stops it, calls the stop hook once, and does nothing else: on Today the "3 new" row would open the inbox */
    sink.accept = true;
    sink.n = 0;
    tap_at(233, 440);                                 /* an earlier touch on Today, so the swallowing below is the code's, not luck */
    find_ev(1);
    sim_step(100);
    CHECK(shows_text(scr, title));
    tap_label("3 new");
    sim_step(100);
    CHECK(!shows_text(scr, title));
    CHECK_EQ(find_stops, 1);
    CHECK_EQ(ui_current_screen(), SCR_TODAY);
    CHECK_EQ(sink.n, 0);
    tap_label("3 new");                               /* the next tap is an ordinary one again */
    CHECK_EQ(ui_current_screen(), SCR_INBOX);
    btn(BTN_LOW);
    btn(BTN_LOW);
    CHECK_EQ(ui_current_screen(), SCR_HOME);

    /* a key stops it and is not a key press for the screen below (BTN_LOW on Today would go home) */
    swipe(UI_EV_SWIPE_RIGHT);
    find_ev(1);
    sim_step(100);
    btn(BTN_LOW);
    sim_step(100);
    CHECK(!shows_text(scr, title));
    CHECK_EQ(find_stops, 2);
    CHECK_EQ(ui_current_screen(), SCR_TODAY);
    btn(BTN_LOW);
    CHECK_EQ(ui_current_screen(), SCR_HOME);

    /* a second FIND(1) while it plays changes nothing; a stray both-buttons release (0 %) does not stop it */
    find_ev(1);
    find_ev(1);
    post_progress(0);
    sim_step(100);
    CHECK(shows_text(scr, title));
    CHECK_EQ(find_stops, 2);

    /* both buttons held: the overlay gives way to the progress ring, then the ICE card, and the sound stops */
    post_progress(30);
    sim_step(100);
    CHECK(!shows_text(scr, title));
    CHECK_EQ(find_stops, 3);
    post_progress(0);
    find_ev(1);
    post(UI_EV_COMBO_FIRE);
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_ICE);
    CHECK(!shows_text(scr, title));
    CHECK_EQ(find_stops, 4);
    post(UI_EV_TOUCH);
    CHECK_EQ(ui_current_screen(), SCR_HOME);

    /* the ICE card's own 15 s timeout is not a touch: it must not stop a sound that plays over it */
    post(UI_EV_COMBO_FIRE);
    find_ev(1);
    sim_step(15100);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    CHECK(shows_text(scr, title));
    CHECK_EQ(find_stops, 4);
    find_ev(0);
    sim_step(100);
    CHECK(!shows_text(scr, title));
    sink.accept = false;
}

/* Works in lost mode and does not leave it: the sound is found by the finder, not turned off by whoever has it. */
static void test_find_overlay_in_lost_mode(void)
{
    lv_obj_t *scr = lv_screen_active();
    const char *title = "Here I am!";
    int stops = find_stops;
    post_lost(1);
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    find_ev(1);
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    CHECK(shows_text(scr, title));
    check_inside("find overlay over lost");
    tap_at(233, 237);                                 /* stops the sound, no hint, still lost */
    sim_step(100);
    CHECK(!shows_text(scr, title));
    CHECK(!shows_text(scr, "Only the owner can turn this off"));
    CHECK_EQ(find_stops, stops + 1);
    CHECK_EQ(ui_current_screen(), SCR_LOST);
    find_ev(1);
    post_lost(0);                                     /* lost mode ending does not end the sound either */
    sim_step(100);
    CHECK_EQ(ui_current_screen(), SCR_HOME);
    CHECK(shows_text(scr, title));
    find_ev(0);
    sim_step(100);
    CHECK(!shows_text(scr, title));
}

int main(void)
{
    sim_init();
    test_flow();
    test_hold_ring();
    test_wifi_status();
    test_short_data();
    test_ice_defaults();
    test_ice_relation_and_show_bits();
    test_lost_fields_follow_show_bits();
    test_cyrillic_and_kazakh_render();
    test_max_length();
    test_home_paired_line();
    test_pair_screen_shot();
    test_first_boot_welcome();
    test_companion_setup();
    test_today_shot();
    test_tap_sends_task_complete();
    test_inbox_shot();
    test_offline_shot();
    test_focus_shots();
    test_failed_read_clears_only_that_notice();
    test_done_ring_is_closed();
    test_idle_screens_do_not_redraw();
    test_gestures_and_lost_mode();
    test_lost_hint_toast_shot();
    test_wifi_toast_shots();
    test_find_overlay_shot();
    test_find_overlay_in_lost_mode();
    return g_failed ? 1 : 0;
}
