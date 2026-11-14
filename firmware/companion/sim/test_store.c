#include <stddef.h>
#include <string.h>
#include "check.h"
#include "store_codec.h"

static void fill_owner(owner_info_t *o)
{
    memset(o, 0, sizeof *o);
    strcpy(o->name, "Aigerim");           strcpy(o->phone, "+7 700 111 22 33");
    strcpy(o->telegram, "@aigerim");      strcpy(o->qr_url, "https://t.me/aigerim");
    strcpy(o->message, "If found, please contact"); strcpy(o->med_note, "Allergy: penicillin");
    strcpy(o->ice_name[0], "Mom");        strcpy(o->ice_phone[0], "+7 701 000 00 01");
    strcpy(o->ice_name[1], "Dad");        strcpy(o->ice_phone[1], "+7 701 000 00 02");
    strcpy(o->email, "aigerim@example.com");
    strcpy(o->ice_rel[0], "Mother");      strcpy(o->ice_rel[1], "Father");
    o->show = OWNER_SHOW_NAME | OWNER_SHOW_MED | OWNER_SHOW_EMAIL;
    o->qr = QR_PHONE;
}

/* recompute the trailing CRC after tampering with the payload */
static void reseal(uint8_t *b, size_t len)
{
    uint32_t c = store_crc32(b, len - 4);
    for (int i = 0; i < 4; i++) b[len - 4 + i] = (uint8_t)(c >> (8 * i));
}

static void test_crc32_known_vector(void)
{
    CHECK_EQ(store_crc32((const uint8_t *)"123456789", 9), 0xCBF43926u);
}

static void test_store_roundtrip_owner(void)
{
    owner_info_t in, out; uint8_t buf[STORE_OWNER_BLOB];
    fill_owner(&in);
    size_t n = store_encode_owner(&in, buf, sizeof buf);
    CHECK_EQ(n, sizeof buf);
    CHECK_EQ(buf[0], STORE_OWNER_VERSION);
    memset(&out, 0, sizeof out);
    CHECK(store_decode_owner(buf, n, &out));
    CHECK(memcmp(&in, &out, sizeof in) == 0);
    CHECK_EQ(store_encode_owner(&in, buf, n - 1), 0); /* cap too small */
}

static void test_store_corrupt_blob_falls_back(void)
{
    owner_info_t in, out; uint8_t buf[STORE_OWNER_BLOB];
    fill_owner(&in);
    size_t n = store_encode_owner(&in, buf, sizeof buf);
    buf[10] ^= 0x01;                                   /* flipped payload byte */
    CHECK(!store_decode_owner(buf, n, &out));
    buf[10] ^= 0x01;
    CHECK(store_decode_owner(buf, n, &out));
    CHECK(!store_decode_owner(buf, n - 1, &out));      /* truncated */
    CHECK(!store_decode_owner(buf, 0, &out));
    CHECK(!store_decode_owner(NULL, 0, &out));
    buf[0] = 99; reseal(buf, n);                       /* valid CRC, unknown version */
    CHECK(!store_decode_owner(buf, n, &out));
}

static void test_owner_overlong_field_truncated(void)
{
    owner_info_t in, out; uint8_t buf[STORE_OWNER_BLOB];
    fill_owner(&in);
    size_t n = store_encode_owner(&in, buf, sizeof buf);
    memset(buf + 1, 'W', sizeof in.name + 5);          /* name fills its buffer and spills over */
    reseal(buf, n);
    CHECK(store_decode_owner(buf, n, &out));
    CHECK(memchr(out.name, 0, sizeof out.name) != NULL);
    CHECK(memchr(out.phone, 0, sizeof out.phone) != NULL);
    CHECK_EQ(strlen(out.name), sizeof out.name - 1);
}

/* v1 blobs only ever held factory data, so a version mismatch falls back to defaults (never a misread layout) */
static void test_v1_blob_falls_back_to_defaults(void)
{
    owner_info_t in, out; uint8_t buf[STORE_OWNER_BLOB];
    fill_owner(&in);
    size_t n = store_encode_owner(&in, buf, sizeof buf);
    CHECK_EQ(buf[0], 2);
    buf[0] = 1; reseal(buf, n);                        /* valid CRC, old version */
    CHECK(!store_decode_owner(buf, n, &out));
    uint8_t old[1 + 33 + 24 + 33 + 97 + 65 + 97 + 2 * 33 + 2 * 24 + 4] = { 1 }; /* the v1 owner layout, exact size */
    reseal(old, sizeof old);
    CHECK(!store_decode_owner(old, sizeof old, &out));
    lost_state_t lin, lout; uint8_t lb[STORE_LOST_BLOB];
    memset(&lin, 0, sizeof lin);
    size_t ln = store_encode_lost(&lin, lb, sizeof lb);
    lb[0] = 1; reseal(lb, ln);
    CHECK(!store_decode_lost(lb, ln, &lout));
}

/* The exact bytes plan-1 firmware wrote for the "wifi" key: version 1, wifi_list_t, CRC32 LE. A board
 * flashed with plan-1 code must keep its networks after the upgrade (no re-provisioning). */
static void test_wifi_v1_blob_from_plan1_still_decodes(void)
{
    uint8_t b[1 + 1 + WIFI_MAX * (33 + 65) + 4] = { 1 /* version */, 2 /* n */ };
    strcpy((char *)b + 2, "Office");                    strcpy((char *)b + 2 + 33, "p@ss word");
    strcpy((char *)b + 2 + 98, "Home");                 /* second net: empty password */
    CHECK_EQ(sizeof b, STORE_WIFI_BLOB);
    reseal(b, sizeof b);
    wifi_list_t out;
    memset(&out, 0xAA, sizeof out);
    CHECK(store_decode_wifi(b, sizeof b, &out));
    CHECK_EQ(out.n, 2);
    CHECK(!strcmp(out.net[0].ssid, "Office") && !strcmp(out.net[0].pass, "p@ss word"));
    CHECK(!strcmp(out.net[1].ssid, "Home") && !out.net[1].pass[0]);
    /* and what we write today is byte-identical to plan 1 */
    uint8_t enc[STORE_WIFI_BLOB];
    CHECK_EQ(store_encode_wifi(&out, enc, sizeof enc), sizeof enc);
    CHECK_EQ(enc[0], 1);
    CHECK(memcmp(enc, b, 2 + 98 * 2) == 0);
}

static void test_owner_v2_fields_terminated(void)
{
    owner_info_t in, out; uint8_t buf[STORE_OWNER_BLOB];
    fill_owner(&in);
    size_t n = store_encode_owner(&in, buf, sizeof buf);
    memset(buf + 1 + offsetof(owner_info_t, email), 'W', sizeof in.email + sizeof in.ice_rel); /* spill over */
    reseal(buf, n);
    CHECK(store_decode_owner(buf, n, &out));
    CHECK(memchr(out.email, 0, sizeof out.email) != NULL);
    CHECK(memchr(out.ice_rel[0], 0, sizeof out.ice_rel[0]) != NULL);
    CHECK(memchr(out.ice_rel[1], 0, sizeof out.ice_rel[1]) != NULL);
}

static void test_wifi_roundtrip_and_overlong(void)
{
    wifi_list_t in, out; uint8_t buf[STORE_WIFI_BLOB];
    memset(&in, 0, sizeof in);
    CHECK(wifi_list_upsert(&in, "Office", "p@ss word"));
    CHECK(wifi_list_upsert(&in, "Home", ""));
    size_t n = store_encode_wifi(&in, buf, sizeof buf);
    CHECK_EQ(n, sizeof buf);
    CHECK(store_decode_wifi(buf, n, &out));
    CHECK_EQ(out.n, 2);
    CHECK(strcmp(out.net[0].ssid, "Office") == 0 && strcmp(out.net[0].pass, "p@ss word") == 0);
    buf[10] ^= 1;
    CHECK(!store_decode_wifi(buf, n, &out));
    buf[10] ^= 1;
    buf[1] = WIFI_MAX + 1; reseal(buf, n);             /* count out of range */
    CHECK(!store_decode_wifi(buf, n, &out));
    buf[1] = 1;
    memset(buf + 2, 'W', sizeof in.net[0].ssid + 5);   /* ssid spills over into pass */
    reseal(buf, n);
    CHECK(store_decode_wifi(buf, n, &out));
    CHECK(memchr(out.net[0].ssid, 0, sizeof out.net[0].ssid) != NULL);
    CHECK(memchr(out.net[0].pass, 0, sizeof out.net[0].pass) != NULL);
}

static void test_wifi_upsert_replaces_same_ssid(void)
{
    wifi_list_t l; memset(&l, 0, sizeof l);
    CHECK(wifi_list_upsert(&l, "A", "one"));
    CHECK(wifi_list_upsert(&l, "B", "two"));
    CHECK(wifi_list_upsert(&l, "A", "three"));
    CHECK_EQ(l.n, 2);
    CHECK(strcmp(l.net[0].ssid, "A") == 0 && strcmp(l.net[0].pass, "three") == 0);
    CHECK(strcmp(l.net[1].ssid, "B") == 0);
}

static void test_wifi_upsert_drops_oldest_when_full(void)
{
    wifi_list_t l; memset(&l, 0, sizeof l);
    const char *names[] = { "s1", "s2", "s3", "s4", "s5", "s6" };
    for (int i = 0; i < 6; i++) CHECK(wifi_list_upsert(&l, names[i], "pw"));
    CHECK_EQ(l.n, WIFI_MAX);
    CHECK(strcmp(l.net[0].ssid, "s2") == 0);
    CHECK(strcmp(l.net[WIFI_MAX - 1].ssid, "s6") == 0);
}

static void test_wifi_upsert_rejects_bad_input(void)
{
    wifi_list_t l; memset(&l, 0, sizeof l);
    char longssid[40], longpass[80];
    memset(longssid, 'S', 33); longssid[33] = 0;
    memset(longpass, 'P', 65); longpass[65] = 0;
    CHECK(!wifi_list_upsert(&l, longssid, "x"));
    CHECK(!wifi_list_upsert(&l, "ok", longpass));
    CHECK(!wifi_list_upsert(&l, "", "x"));
    CHECK(!wifi_list_upsert(&l, NULL, "x"));
    CHECK_EQ(l.n, 0);
}

static void seed_abc(wifi_list_t *l)
{
    memset(l, 0, sizeof *l);
    CHECK(wifi_list_upsert(l, "A", "pa"));
    CHECK(wifi_list_upsert(l, "B", "pb"));
    CHECK(wifi_list_upsert(l, "C", "pc"));
}

static void test_wifi_remove(void)
{
    wifi_list_t l; seed_abc(&l);
    CHECK(wifi_list_remove(&l, "B"));
    CHECK_EQ(l.n, 2);
    CHECK(!strcmp(l.net[0].ssid, "A") && !strcmp(l.net[1].ssid, "C") && !strcmp(l.net[1].pass, "pc"));
    CHECK(l.net[2].ssid[0] == 0 && l.net[2].pass[0] == 0); /* the vacated slot holds no password */
    CHECK(!wifi_list_remove(&l, "B"));                   /* gone already: unchanged */
    CHECK(!wifi_list_remove(&l, "b"));                   /* exact match only */
    CHECK(!wifi_list_remove(&l, ""));
    CHECK(!wifi_list_remove(&l, NULL));
    CHECK_EQ(l.n, 2);
    CHECK(wifi_list_remove(&l, "A") && wifi_list_remove(&l, "C"));
    CHECK_EQ(l.n, 0);
    CHECK(!wifi_list_remove(&l, "A"));
}

static void test_wifi_can_remove_never_strands_the_board(void)
{
    wifi_list_t l; seed_abc(&l);
    CHECK(wifi_list_can_remove(&l, "A", "B"));           /* another network is in use: fine */
    CHECK(wifi_list_can_remove(&l, "A", ""));            /* offline: fine while others stay */
    CHECK(wifi_list_can_remove(&l, "A", NULL));
    CHECK(!wifi_list_can_remove(&l, "B", "B"));          /* the connected network */
    CHECK(wifi_list_can_remove(&l, "Nope", "B"));        /* not saved: nothing to remove, nothing to refuse */
    CHECK(wifi_list_remove(&l, "C") && wifi_list_remove(&l, "B"));
    CHECK_EQ(l.n, 1);
    CHECK(!wifi_list_can_remove(&l, "A", ""));           /* the last saved network, even when offline */
    CHECK(!wifi_list_can_remove(&l, "A", "Other"));
    CHECK(wifi_list_can_remove(&l, "Nope", ""));
    CHECK(wifi_list_can_remove(&l, "", "A") && wifi_list_can_remove(&l, NULL, "A")); /* bad input: the remove itself is a no-op */
    CHECK_EQ(l.n, 1);                                    /* the check never edits */
}

static void test_wifi_reorder_partial_and_unknown(void)
{
    wifi_list_t l; seed_abc(&l);
    char o1[2][33] = { "C", "A" };                       /* partial: C, A first, B keeps its place after them */
    CHECK(wifi_list_reorder(&l, o1, 2));
    CHECK_EQ(l.n, 3);
    CHECK(!strcmp(l.net[0].ssid, "C") && !strcmp(l.net[1].ssid, "A") && !strcmp(l.net[2].ssid, "B"));
    CHECK(!strcmp(l.net[0].pass, "pc") && !strcmp(l.net[2].pass, "pb")); /* passwords travel with their network */
    char o2[3][33] = { "Nope", "B", "Nope" };            /* unknown names are ignored */
    CHECK(wifi_list_reorder(&l, o2, 3));
    CHECK(!strcmp(l.net[0].ssid, "B") && !strcmp(l.net[1].ssid, "C") && !strcmp(l.net[2].ssid, "A"));
    char o3[3][33] = { "B", "B", "C" };                  /* a repeated name counts once */
    CHECK(!wifi_list_reorder(&l, o3, 3));                /* B, C, A is already the order: unchanged */
    CHECK_EQ(l.n, 3);
    char o4[1][33] = { "Nope" };
    CHECK(!wifi_list_reorder(&l, o4, 1));
    CHECK(!wifi_list_reorder(&l, o4, 0));
    CHECK(!strcmp(l.net[0].ssid, "B") && !strcmp(l.net[1].ssid, "C") && !strcmp(l.net[2].ssid, "A"));
    char o5[3][33] = { "A", "C", "B" };                  /* a full reverse */
    CHECK(wifi_list_reorder(&l, o5, 3));
    CHECK(!strcmp(l.net[0].ssid, "A") && !strcmp(l.net[1].ssid, "C") && !strcmp(l.net[2].ssid, "B"));
    uint8_t buf[STORE_WIFI_BLOB], v = 0;                 /* the blob format is untouched */
    CHECK_EQ(store_encode_wifi(&l, buf, sizeof buf), sizeof buf);
    v = buf[0];
    CHECK_EQ(v, 1);
}

static void test_lost_roundtrip(void)
{
    lost_state_t in, out; uint8_t buf[STORE_LOST_BLOB];
    memset(&in, 0, sizeof in);
    in.on = true; in.rev = 0x01020304u; fill_owner(&in.shown);
    size_t n = store_encode_lost(&in, buf, sizeof buf);
    CHECK_EQ(n, sizeof buf);
    CHECK(store_decode_lost(buf, n, &out));
    CHECK(out.on && out.rev == 0x01020304u && memcmp(&in.shown, &out.shown, sizeof in.shown) == 0);
    buf[3] ^= 1;
    CHECK(!store_decode_lost(buf, n, &out));
    buf[3] ^= 1;
    buf[1] = 7; reseal(buf, n);                        /* bool must stay 0/1 */
    CHECK(store_decode_lost(buf, n, &out));
    CHECK_EQ(out.on, 1);
    memset(buf + 1 + 1 + 4 + offsetof(owner_info_t, name), 'W', sizeof in.shown.name + 5); /* over-long name in the lost snapshot */
    reseal(buf, n);
    CHECK(store_decode_lost(buf, n, &out));
    CHECK(memchr(out.shown.name, 0, sizeof out.shown.name) != NULL);
}

static void test_ice_rev_survives_the_owner_blob(void)
{
    owner_info_t in, out; uint8_t buf[STORE_OWNER_BLOB];
    fill_owner(&in);
    in.ice_rev = 0xA1B2C3D4u;
    size_t n = store_encode_owner(&in, buf, sizeof buf);
    CHECK_EQ(n, sizeof buf);
    CHECK_EQ(buf[0], 2);
    CHECK(store_decode_owner(buf, n, &out));
    CHECK_EQ(out.ice_rev, 0xA1B2C3D4u);
}

static void test_pair_roundtrip_and_corrupt(void)
{
    pair_rec_t in, out; uint8_t buf[STORE_PAIR_BLOB];
    memset(&in, 0, sizeof in);
    strcpy(in.device_id, "7b0e5c3a-4d21-4f6b-9a38-2c1d5e8f0a64");
    strcpy(in.api_url, "https://aelys.example.com");
    for (int i = 0; i < 32; i++) in.priv[i] = (uint8_t)(i * 7 + 1);
    size_t n = store_encode_pair(&in, buf, sizeof buf);
    CHECK_EQ(n, sizeof buf);
    CHECK_EQ(buf[0], STORE_PAIR_VERSION);
    CHECK_EQ(STORE_PAIR_VERSION, 1);
    memset(&out, 0, sizeof out);
    CHECK(store_decode_pair(buf, n, &out));
    CHECK(memcmp(&in, &out, sizeof in) == 0);
    CHECK_EQ(store_encode_pair(&in, buf, n - 1), 0);   /* cap too small */
    buf[5] ^= 1;                                       /* flipped payload byte */
    CHECK(!store_decode_pair(buf, n, &out));
    buf[5] ^= 1;
    CHECK(!store_decode_pair(buf, n - 1, &out));       /* truncated */
    CHECK(!store_decode_pair(NULL, 0, &out));
    buf[0] = 9; reseal(buf, n);                        /* valid CRC, unknown version */
    CHECK(!store_decode_pair(buf, n, &out));
    buf[0] = STORE_PAIR_VERSION;
    memset(buf + 1, 'W', sizeof in.device_id + 5);     /* device_id spills into api_url */
    reseal(buf, n);
    CHECK(store_decode_pair(buf, n, &out));
    CHECK(memchr(out.device_id, 0, sizeof out.device_id) != NULL);
    CHECK(memchr(out.api_url, 0, sizeof out.api_url) != NULL);
}

static void fill_snap(snap_t *s)
{
    memset(s, 0, sizeof *s);
    s->generated = 1794493920;
    s->has_task = s->has_event = true;
    strcpy(s->task.id, "t-101"); strcpy(s->task.title, "Ship pairing ADR"); s->task.due = 1794506400;
    strcpy(s->event.id, "e-22"); strcpy(s->event.title, "Design review"); s->event.starts = 1794499200; s->event.has_end = true;
    s->overdue = 1; s->unread = 3; s->other_unread = -1; s->today_done = 5; s->today_total = 8;
    s->n_notices = 2;
    strcpy(s->notices[1].id, "n-2"); strcpy(s->notices[1].kind, "calendar.reminder"); strcpy(s->notices[1].title, "Design review");
    s->notices[1].created = 1794493000;
    s->focus.status = FOCUS_PAUSED; strcpy(s->focus.id, "f-3"); strcpy(s->focus.mode, "pomodoro"); s->focus.elapsed_s = 1072;
}

static void test_snap_roundtrip(void)
{
    snap_t in, out;
    uint8_t buf[STORE_SNAP_BLOB];
    fill_snap(&in);
    size_t n = store_encode_snap(&in, buf, sizeof buf);
    CHECK_EQ(n, sizeof buf);
    CHECK_EQ(buf[0], STORE_SNAP_VERSION);
    CHECK_EQ(store_encode_snap(&in, buf, n - 1), 0);
    memset(&out, 0xAA, sizeof out);
    CHECK(store_decode_snap(buf, n, &out));
    CHECK_EQ(out.generated, in.generated);
    CHECK(strcmp(out.task.title, "Ship pairing ADR") == 0 && out.task.due == in.task.due);
    CHECK(strcmp(out.event.title, "Design review") == 0 && out.event.has_end);
    CHECK_EQ(out.other_unread, -1);
    CHECK_EQ(out.today_total, 8);
    CHECK_EQ(out.n_notices, 2);
    CHECK(strcmp(out.notices[1].kind, "calendar.reminder") == 0);
    CHECK_EQ(out.focus.status, FOCUS_PAUSED);
    CHECK_EQ(out.focus.elapsed_s, 1072);

    memset(&out, 0xAA, sizeof out);                    /* failures leave *out alone */
    buf[10] ^= 1;                                      /* CRC */
    CHECK(!store_decode_snap(buf, n, &out));
    CHECK_EQ(((uint8_t *)&out)[0], 0xAA);
    buf[10] ^= 1;
    CHECK(!store_decode_snap(buf, n - 1, &out));       /* length of another layout */
    buf[0] = STORE_SNAP_VERSION + 1;
    reseal(buf, n);
    CHECK(!store_decode_snap(buf, n, &out));           /* another version */
    CHECK(!store_decode_owner(buf, n, (owner_info_t[1]){0})); /* and never mistaken for another blob */
}

static void test_snap_overlong_and_bad_counts_are_made_safe(void)
{
    snap_t in, out;
    uint8_t buf[STORE_SNAP_BLOB];
    fill_snap(&in);
    store_encode_snap(&in, buf, sizeof buf);
    memset(buf + 1 + offsetof(snap_t, task.title), 'W', sizeof in.task.title + 5); /* spills into due: the strings must still end */
    reseal(buf, sizeof buf);
    CHECK(store_decode_snap(buf, sizeof buf, &out));
    CHECK(memchr(out.task.title, 0, sizeof out.task.title) != NULL);
    store_encode_snap(&in, buf, sizeof buf);
    buf[1 + offsetof(snap_t, n_notices)] = 9;          /* more notices than the array holds */
    reseal(buf, sizeof buf);
    CHECK(!store_decode_snap(buf, sizeof buf, &out));
    store_encode_snap(&in, buf, sizeof buf);
    buf[1 + offsetof(snap_t, focus.status)] = 7;
    reseal(buf, sizeof buf);
    CHECK(!store_decode_snap(buf, sizeof buf, &out));
}

#define TEST_OWNER_LEN 65
#define TEST_BOUND_BLOB (1 + TEST_OWNER_LEN + sizeof(snap_t) + 4)

static void test_owned_snapshot(void)
{
    snap_t in, out, sentinel;
    uint8_t owner[TEST_OWNER_LEN] = {4, 1}, other[TEST_OWNER_LEN] = {4, 2};
    uint8_t b[TEST_BOUND_BLOB + 1], canonical[TEST_BOUND_BLOB];
    fill_snap(&in);
    memset(b, 0xa5, sizeof b);
    size_t n = store_encode_snap_owned(&in, owner, b, TEST_BOUND_BLOB);
    CHECK_EQ(n, 1 + 65 + 1088 + 4);
    if (n != TEST_BOUND_BLOB) return;
    CHECK_EQ(b[0], 2);
    CHECK(memcmp(b + 1, owner, 65) == 0);
    CHECK_EQ(b[TEST_BOUND_BLOB], 0xa5);
    CHECK(store_decode_snap_owned(b, n, owner, &out));
    CHECK_EQ(out.generated, in.generated);
    CHECK(strcmp(out.task.title, in.task.title) == 0);
    CHECK_EQ(out.focus.elapsed_s, in.focus.elapsed_s);
    memcpy(canonical, b, n);
    /* Deliberately dirty structure padding and the unused tail of a string. */
    ((uint8_t *)&in)[offsetof(snap_t, task) + offsetof(snap_task_t, title) + sizeof in.task.title] = 0xcc;
    in.task.id[10] = 'X';
    CHECK_EQ(store_encode_snap_owned(&in, owner, b, TEST_BOUND_BLOB), n);
    CHECK(memcmp(b, canonical, n) == 0);

    memset(&sentinel, 0xa5, sizeof sentinel);
    memcpy(&out, &sentinel, sizeof out);
#define REJECT(expr) do { CHECK(!(expr)); CHECK(memcmp(&out, &sentinel, sizeof out) == 0); } while (0)
    REJECT(store_decode_snap_owned(b, n, other, &out));
    memcpy(other, owner, sizeof other); other[64] ^= 1;
    REJECT(store_decode_snap_owned(b, n, other, &out));
    REJECT(store_decode_snap_owned(b, n, NULL, &out));
    REJECT(store_decode_snap_owned(NULL, n, owner, &out));
    REJECT(store_decode_snap_owned(b, n - 1, owner, &out));
    REJECT(store_decode_snap_owned(b, n + 1, owner, &out));
    CHECK(!store_decode_snap_owned(b, n, owner, NULL));
    b[n - 1] ^= 1; REJECT(store_decode_snap_owned(b, n, owner, &out)); b[n - 1] ^= 1;
    b[1] ^= 1; REJECT(store_decode_snap_owned(b, n, owner, &out)); b[1] ^= 1;
    b[1] ^= 1; reseal(b, n); REJECT(store_decode_snap_owned(b, n, owner, &out));
    memcpy(b, canonical, n);
    b[1 + 65 + 10] ^= 1; REJECT(store_decode_snap_owned(b, n, owner, &out)); b[1 + 65 + 10] ^= 1;
    b[0] = 3; reseal(b, n); REJECT(store_decode_snap_owned(b, n, owner, &out));
    memcpy(b, canonical, n);
    b[1 + 65 + offsetof(snap_t, n_notices)] = 6; reseal(b, n);
    REJECT(store_decode_snap_owned(b, n, owner, &out));
    memcpy(b, canonical, n);
    b[1 + 65 + offsetof(snap_t, focus.status)] = 9; reseal(b, n);
    REJECT(store_decode_snap_owned(b, n, owner, &out));
    memcpy(b, canonical, n);
    b[1 + 65 + offsetof(snap_t, has_task)] = 2; reseal(b, n);
    REJECT(store_decode_snap_owned(b, n, owner, &out));
    uint8_t legacy[STORE_SNAP_BLOB];
    CHECK_EQ(store_encode_snap(&in, legacy, sizeof legacy), sizeof legacy);
    REJECT(store_decode_snap_owned(legacy, sizeof legacy, owner, &out));
#undef REJECT
    memset(b, 0xa5, sizeof b);
    CHECK_EQ(store_encode_snap_owned(&in, NULL, b, TEST_BOUND_BLOB), 0);
    CHECK_EQ(store_encode_snap_owned(NULL, owner, b, TEST_BOUND_BLOB), 0);
    CHECK_EQ(store_encode_snap_owned(&in, owner, NULL, TEST_BOUND_BLOB), 0);
    CHECK_EQ(store_encode_snap_owned(&in, owner, b, TEST_BOUND_BLOB - 1), 0);
    in.n_notices = 6;
    CHECK_EQ(store_encode_snap_owned(&in, owner, b, TEST_BOUND_BLOB), 0);
    in.n_notices = 0; in.focus.status = 9;
    CHECK_EQ(store_encode_snap_owned(&in, owner, b, TEST_BOUND_BLOB), 0);
    for (size_t i = 0; i < sizeof b; i++) CHECK_EQ(b[i], 0xa5);
}

static void test_settings_roundtrip_and_bounds(void)
{
    settings_t in = { .brightness = 35, .rev = 7 }, out = { 0 }; uint8_t buf[STORE_SETTINGS_BLOB];
    size_t n = store_encode_settings(&in, buf, sizeof buf);
    CHECK_EQ(n, sizeof buf);
    CHECK_EQ(buf[0], STORE_SETTINGS_VERSION);
    CHECK_EQ(STORE_SETTINGS_VERSION, 1);
    CHECK(store_decode_settings(buf, n, &out));
    CHECK(out.brightness == 35 && out.rev == 7);
    CHECK_EQ(store_encode_settings(&in, buf, n - 1), 0); /* too small */
    buf[2] ^= 1;
    CHECK(!store_decode_settings(buf, n, &out));         /* corrupt */
    store_encode_settings(&in, buf, sizeof buf);
    buf[0] = 2; reseal(buf, n);
    CHECK(!store_decode_settings(buf, n, &out));         /* another version */
    store_encode_settings(&in, buf, sizeof buf);
    buf[1] = 4; reseal(buf, n);                          /* a valid CRC does not make 4 % a brightness */
    CHECK(!store_decode_settings(buf, n, &out));
    buf[1] = 101; reseal(buf, n);
    CHECK(!store_decode_settings(buf, n, &out));
    CHECK(!store_decode_settings(buf, n - 1, &out));
    CHECK(out.brightness == 35 && out.rev == 7);         /* untouched by every failure */
}

int main(void)
{
    test_crc32_known_vector();
    test_store_roundtrip_owner();
    test_store_corrupt_blob_falls_back();
    test_owner_overlong_field_truncated();
    test_v1_blob_falls_back_to_defaults();
    test_wifi_v1_blob_from_plan1_still_decodes();
    test_owner_v2_fields_terminated();
    test_wifi_roundtrip_and_overlong();
    test_wifi_upsert_replaces_same_ssid();
    test_wifi_upsert_drops_oldest_when_full();
    test_wifi_upsert_rejects_bad_input();
    test_wifi_remove();
    test_wifi_can_remove_never_strands_the_board();
    test_wifi_reorder_partial_and_unknown();
    test_lost_roundtrip();
    test_ice_rev_survives_the_owner_blob();
    test_pair_roundtrip_and_corrupt();
    test_owned_snapshot();
    test_snap_roundtrip();
    test_snap_overlong_and_bad_counts_are_made_safe();
    test_settings_roundtrip_and_bounds();
    return g_failed ? 1 : 0;
}
