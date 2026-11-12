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

int main(void)
{
    test_ice_fields_land_in_owner();
    test_lost_on_keeps_ice_fields();
    test_ice_update_while_lost_updates_shown();
    test_ice_update_while_not_lost_leaves_shown();
    test_lost_hides_unselected_contacts();
    test_lost_off_clears_flag_only();
    test_long_fields_stay_terminated();
    return g_failed ? 1 : 0;
}
