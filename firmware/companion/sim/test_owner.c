#include <string.h>
#include "check.h"
#include "store_codec.h"

static void ice_fixture(ice_cmd_t *c)
{
    memset(c, 0, sizeof *c);
    strcpy(c->owner_name, "Aigerim");
    c->n = 2;
    strcpy(c->name[0], "Mom"); strcpy(c->rel[0], "Mother"); strcpy(c->phone[0], "+0 000 000 00 01");
    strcpy(c->name[1], "Dad"); strcpy(c->rel[1], "Father"); strcpy(c->phone[1], "+0 000 000 00 02");
    strcpy(c->med_note, "Allergy: penicillin");
    c->show_name = c->show_contacts = c->show_med = true;
}

static void lost_fixture(lost_cmd_t *c)
{
    memset(c, 0, sizeof *c);
    c->on = true;
    strcpy(c->message, "Please call me");
    c->show_phone = c->show_telegram = c->show_email = true;
    strcpy(c->email, "a@example.com");
    c->qr = QR_PHONE;
}

static void with_ice(owner_info_t *o)
{
    ice_cmd_t c; lost_state_t none = { 0 };
    owner_defaults(o);
    ice_fixture(&c);
    owner_apply_ice(o, &none, &c);
}

static void test_ice_fields_land_in_owner(void)
{
    owner_info_t o; with_ice(&o);
    CHECK(!strcmp(o.name, "Aigerim"));
    CHECK(!strcmp(o.ice_rel[1], "Father"));
    CHECK(!strcmp(o.ice_phone[0], "+0 000 000 00 01"));
    CHECK_EQ(o.show & (OWNER_SHOW_NAME | OWNER_SHOW_CONTACTS | OWNER_SHOW_MED), OWNER_SHOW_NAME | OWNER_SHOW_CONTACTS | OWNER_SHOW_MED);
}

static void test_lost_on_keeps_ice_fields(void)
{
    owner_info_t o; lost_state_t l = { 0 }; lost_cmd_t c;
    with_ice(&o);
    lost_fixture(&c);
    owner_apply_lost(&l, &o, &c);
    CHECK(l.on);
    CHECK(!strcmp(l.shown.name, "Aigerim"));
    CHECK(!strcmp(l.shown.med_note, "Allergy: penicillin"));
    CHECK(!strcmp(l.shown.ice_name[0], "Mom") && !strcmp(l.shown.ice_name[1], "Dad"));
    CHECK(!strcmp(l.shown.ice_rel[0], "Mother"));
    CHECK(!strcmp(l.shown.ice_phone[1], "+0 000 000 00 02"));
    CHECK(!strcmp(l.shown.message, "Please call me"));
    CHECK(!strcmp(l.shown.email, "a@example.com"));
    CHECK_EQ(l.shown.qr, QR_PHONE);
    CHECK(l.shown.phone[0]);
}

static void test_ice_update_while_lost_updates_shown(void)
{
    owner_info_t o; lost_state_t l = { 0 }; lost_cmd_t lc; ice_cmd_t ic;
    with_ice(&o);
    lost_fixture(&lc);
    owner_apply_lost(&l, &o, &lc);
    ice_fixture(&ic);
    strcpy(ic.med_note, "Asthma"); strcpy(ic.name[0], "Sister");
    owner_apply_ice(&o, &l, &ic);
    CHECK(!strcmp(o.med_note, "Asthma"));
    CHECK(!strcmp(l.shown.med_note, "Asthma"));
    CHECK(!strcmp(l.shown.ice_name[0], "Sister"));
    CHECK(!strcmp(l.shown.message, "Please call me")); /* lost-only fields stay */
}

static void test_ice_update_while_not_lost_leaves_shown(void)
{
    owner_info_t o; lost_state_t l = { 0 }; lost_cmd_t lc; ice_cmd_t ic;
    with_ice(&o);
    lost_fixture(&lc);
    owner_apply_lost(&l, &o, &lc);
    l.on = false;
    ice_fixture(&ic);
    strcpy(ic.med_note, "Asthma");
    owner_apply_ice(&o, &l, &ic);
    CHECK(!strcmp(o.med_note, "Asthma"));
    CHECK(!strcmp(l.shown.med_note, "Allergy: penicillin"));
}

static void test_lost_hides_unselected_contacts(void)
{
    owner_info_t o; lost_state_t l = { 0 }; lost_cmd_t c;
    with_ice(&o);
    lost_fixture(&c);
    c.show_phone = false; c.show_email = false; c.qr = QR_PHONE;
    owner_apply_lost(&l, &o, &c);
    CHECK_EQ(l.shown.phone[0], 0);
    CHECK_EQ(l.shown.email[0], 0);
    CHECK(l.shown.telegram[0]);
    CHECK_EQ(l.shown.qr_url[0], 0); /* QR of a hidden phone would leak it */
    c.qr = QR_NONE;
    owner_apply_lost(&l, &o, &c);
    CHECK_EQ(l.shown.qr_url[0], 0);
    c.qr = QR_TELEGRAM;
    owner_apply_lost(&l, &o, &c);
    CHECK(l.shown.qr_url[0]);
}

static void test_lost_off_clears_flag_only(void)
{
    owner_info_t o; lost_state_t l = { 0 }; lost_cmd_t c;
    with_ice(&o);
    lost_fixture(&c);
    owner_apply_lost(&l, &o, &c);
    c.on = false;
    owner_apply_lost(&l, &o, &c);
    CHECK(!l.on);
    CHECK(!strcmp(l.shown.message, "Please call me"));
}

static void test_long_fields_stay_terminated(void)
{
    owner_info_t o; lost_state_t l = { 0 }; ice_cmd_t c;
    owner_defaults(&o);
    ice_fixture(&c);
    memset(c.owner_name, 'W', sizeof c.owner_name); /* unterminated */
    memset(c.rel[0], 'W', sizeof c.rel[0]);
    owner_apply_ice(&o, &l, &c);
    CHECK_EQ(strlen(o.name), sizeof o.name - 1);
    CHECK_EQ(strlen(o.ice_rel[0]), sizeof o.ice_rel[0] - 1);
}

static void test_stale_ice_rev_changes_nothing(void)
{
    owner_info_t o; lost_state_t l = { 0 }; ice_cmd_t c;
    owner_defaults(&o);
    ice_fixture(&c);
    c.rev = 5;
    CHECK(owner_apply_ice(&o, &l, &c));
    CHECK_EQ(o.ice_rev, 5);
    strcpy(c.med_note, "stale");
    for (uint32_t r = 1; r <= 5; r++) {                  /* older and equal (a redelivery) are both refused */
        c.rev = r;
        CHECK(!owner_apply_ice(&o, &l, &c));
        CHECK(!strcmp(o.med_note, "Allergy: penicillin"));
        CHECK_EQ(o.ice_rev, 5);
    }
    c.rev = 6;
    CHECK(owner_apply_ice(&o, &l, &c));
    CHECK(!strcmp(o.med_note, "stale"));
    CHECK_EQ(o.ice_rev, 6);
    c.rev = 0; strcpy(c.med_note, "unversioned");        /* rev 0 always applies and never lowers the stored rev */
    CHECK(owner_apply_ice(&o, &l, &c));
    CHECK(!strcmp(o.med_note, "unversioned"));
    CHECK_EQ(o.ice_rev, 6);
}

static void test_stale_lost_rev_changes_nothing(void)
{
    owner_info_t o; lost_state_t l = { 0 }; lost_cmd_t c;
    with_ice(&o);
    lost_fixture(&c);
    c.rev = 3;
    CHECK(owner_apply_lost(&l, &o, &c));
    CHECK(l.on);
    CHECK_EQ(l.rev, 3);
    c.on = false; c.rev = 2;                             /* an older "off" arriving late must not end lost mode */
    CHECK(!owner_apply_lost(&l, &o, &c));
    CHECK(l.on);
    c.rev = 3;
    CHECK(!owner_apply_lost(&l, &o, &c));
    CHECK(l.on);
    c.rev = 4;
    CHECK(owner_apply_lost(&l, &o, &c));
    CHECK(!l.on);
    CHECK_EQ(l.rev, 4);
    c.on = true; c.rev = 0;                              /* unversioned applies, rev stays */
    CHECK(owner_apply_lost(&l, &o, &c));
    CHECK(l.on);
    CHECK_EQ(l.rev, 4);
}

static void test_lost_command_roundtrip_through_store(void)
{
    owner_info_t o, o2; lost_state_t l = { 0 }, l2 = { 0 }; lost_cmd_t c;
    uint8_t ob[STORE_OWNER_BLOB], lb[STORE_LOST_BLOB];
    with_ice(&o);
    lost_fixture(&c);
    c.rev = 9;
    CHECK(owner_apply_lost(&l, &o, &c));
    CHECK_EQ(store_encode_owner(&o, ob, sizeof ob), sizeof ob);
    CHECK_EQ(store_encode_lost(&l, lb, sizeof lb), sizeof lb);
    CHECK(store_decode_owner(ob, sizeof ob, &o2));
    CHECK(store_decode_lost(lb, sizeof lb, &l2));
    CHECK(!memcmp(&o, &o2, sizeof o));
    CHECK(l2.on && l2.rev == 9 && !memcmp(&l.shown, &l2.shown, sizeof l.shown));
    c.on = false; c.rev = 10;                            /* a reboot after "off" stays off, rev kept */
    CHECK(owner_apply_lost(&l, &o, &c));
    CHECK_EQ(store_encode_lost(&l, lb, sizeof lb), sizeof lb);
    CHECK(store_decode_lost(lb, sizeof lb, &l2));
    CHECK(!l2.on && l2.rev == 10);
}

/* ice_update while lost: the owner blob and the lost blob both carry the new data (the board saves both) */
static void test_ice_while_lost_roundtrips_both_blobs(void)
{
    owner_info_t o, o2; lost_state_t l = { 0 }, l2 = { 0 }; lost_cmd_t lc; ice_cmd_t ic;
    uint8_t ob[STORE_OWNER_BLOB], lb[STORE_LOST_BLOB];
    with_ice(&o);
    lost_fixture(&lc);
    owner_apply_lost(&l, &o, &lc);
    ice_fixture(&ic);
    strcpy(ic.med_note, "Asthma");
    ic.rev = 4;
    CHECK(owner_apply_ice(&o, &l, &ic));
    store_encode_owner(&o, ob, sizeof ob);
    store_encode_lost(&l, lb, sizeof lb);
    CHECK(store_decode_owner(ob, sizeof ob, &o2) && store_decode_lost(lb, sizeof lb, &l2));
    CHECK(!strcmp(o2.med_note, "Asthma") && !strcmp(l2.shown.med_note, "Asthma"));
    CHECK_EQ(o2.ice_rev, 4);
    CHECK(!strcmp(l2.shown.message, "Please call me"));
}

static void test_settings_apply_and_brightness_map(void)
{
    settings_t s;
    settings_defaults(&s);
    CHECK_EQ(s.brightness, 100);
    CHECK_EQ(s.rev, 0);
    CHECK(settings_apply(&s, 40, 3));
    CHECK_EQ(s.brightness, 40);
    CHECK_EQ(s.rev, 3);
    CHECK(!settings_apply(&s, 80, 3));                   /* a redelivery */
    CHECK(!settings_apply(&s, 80, 2));                   /* an older one arriving late */
    CHECK_EQ(s.brightness, 40);
    CHECK(settings_apply(&s, 1, 4));                     /* out of range is clamped, never stored as is */
    CHECK_EQ(s.brightness, 5);
    CHECK(settings_apply(&s, 250, 0));                   /* unversioned applies, rev stays */
    CHECK_EQ(s.brightness, 100);
    CHECK_EQ(s.rev, 4);

    CHECK_EQ(brightness_raw(5), 13);                     /* 5..100 % -> 13..255 */
    CHECK_EQ(brightness_raw(100), 255);
    CHECK_EQ(brightness_raw(50), 128);
    CHECK_EQ(brightness_raw(0), 13);
    CHECK_EQ(brightness_raw(200), 255);
}

int main(void)
{
    test_ice_fields_land_in_owner();
    test_lost_on_keeps_ice_fields();
    test_ice_update_while_lost_updates_shown();
    test_ice_update_while_not_lost_leaves_shown();
    test_lost_hides_unselected_contacts();
    test_lost_off_clears_flag_only();
    test_long_fields_stay_terminated();
    test_stale_ice_rev_changes_nothing();
    test_stale_lost_rev_changes_nothing();
    test_lost_command_roundtrip_through_store();
    test_ice_while_lost_roundtrips_both_blobs();
    test_settings_apply_and_brightness_map();
    return g_failed ? 1 : 0;
}
