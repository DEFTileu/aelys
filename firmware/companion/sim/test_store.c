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
    CHECK_EQ(buf[0], STORE_VERSION);
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

static void test_lost_roundtrip(void)
{
    lost_state_t in, out; uint8_t buf[STORE_LOST_BLOB];
    memset(&in, 0, sizeof in);
    in.on = true; fill_owner(&in.shown);
    size_t n = store_encode_lost(&in, buf, sizeof buf);
    CHECK_EQ(n, sizeof buf);
    CHECK(store_decode_lost(buf, n, &out));
    CHECK(out.on && memcmp(&in.shown, &out.shown, sizeof in.shown) == 0);
    buf[3] ^= 1;
    CHECK(!store_decode_lost(buf, n, &out));
    buf[3] ^= 1;
    buf[1] = 7; reseal(buf, n);                        /* bool must stay 0/1 */
    CHECK(store_decode_lost(buf, n, &out));
    CHECK_EQ(out.on, 1);
    memset(buf + 2, 'W', sizeof in.shown.name + 5);    /* over-long name in the lost snapshot */
    reseal(buf, n);
    CHECK(store_decode_lost(buf, n, &out));
    CHECK(memchr(out.shown.name, 0, sizeof out.shown.name) != NULL);
}

int main(void)
{
    test_crc32_known_vector();
    test_store_roundtrip_owner();
    test_store_corrupt_blob_falls_back();
    test_owner_overlong_field_truncated();
    test_wifi_roundtrip_and_overlong();
    test_wifi_upsert_replaces_same_ssid();
    test_wifi_upsert_drops_oldest_when_full();
    test_wifi_upsert_rejects_bad_input();
    test_lost_roundtrip();
    return g_failed ? 1 : 0;
}
