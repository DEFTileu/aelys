#define _GNU_SOURCE
#include <string.h>
#include "check.h"
#include "improv.h"

/* feed a whole buffer; returns the last non-zero result (and the frame in *out) */
static int feed_all(improv_parser_t *p, const uint8_t *b, size_t n, improv_frame_t *out)
{
    int r = 0;
    for (size_t i = 0; i < n; i++) { int x = improv_feed(p, b[i], out); if (x) r = x; }
    return r;
}

static size_t wifi_rpc(uint8_t *buf, size_t cap, const char *ssid, const char *pass)
{
    uint8_t d[255];
    size_t sl = strlen(ssid), pl = strlen(pass), i = 0;
    d[i++] = IMPROV_RPC_WIFI;
    d[i++] = (uint8_t)(2 + sl + pl);
    d[i++] = (uint8_t)sl; memcpy(d + i, ssid, sl); i += sl;
    d[i++] = (uint8_t)pl; memcpy(d + i, pass, pl); i += pl;
    return improv_build(IMPROV_TYPE_RPC, d, i, buf, cap);
}

static void test_build_then_parse_roundtrip(void)
{
    uint8_t buf[64], data[] = { 1, 2, 3, 250 };
    size_t n = improv_build(IMPROV_TYPE_RESULT, data, sizeof data, buf, sizeof buf);
    CHECK_EQ(n, 10 + sizeof data);
    CHECK(memcmp(buf, "IMPROV", 6) == 0);
    CHECK_EQ(buf[6], IMPROV_VERSION);
    uint8_t sum = 0; for (size_t i = 0; i + 1 < n; i++) sum += buf[i];
    CHECK_EQ(buf[n - 1], sum);

    improv_parser_t p; memset(&p, 0, sizeof p);
    improv_frame_t f; memset(&f, 0, sizeof f);
    for (size_t i = 0; i + 1 < n; i++) CHECK_EQ(improv_feed(&p, buf[i], &f), 0);
    CHECK_EQ(improv_feed(&p, buf[n - 1], &f), 1);
    CHECK_EQ(f.type, IMPROV_TYPE_RESULT);
    CHECK_EQ(f.len, sizeof data);
    CHECK(memcmp(f.data, data, sizeof data) == 0);
    CHECK_EQ(improv_build(IMPROV_TYPE_RESULT, data, sizeof data, buf, n - 1), 0);
}

static void test_bad_checksum_rejected(void)
{
    uint8_t buf[64], data[] = { 9, 9 };
    size_t n = improv_build(IMPROV_TYPE_STATE, data, sizeof data, buf, sizeof buf);
    improv_parser_t p; memset(&p, 0, sizeof p);
    improv_frame_t f;
    buf[n - 1] ^= 0x55;
    CHECK_EQ(feed_all(&p, buf, n, &f), -1);
    buf[n - 1] ^= 0x55;                       /* parser recovered: next good frame decodes */
    CHECK_EQ(feed_all(&p, buf, n, &f), 1);
}

static void test_garbage_before_header_skipped(void)
{
    uint8_t buf[64], in[80], data[] = { 7 };
    size_t n = improv_build(IMPROV_TYPE_STATE, data, sizeof data, buf, sizeof buf);
    const uint8_t junk[] = { 0x00, 'x', 'I', 'M', 'P', 'R', 'O', 'I' }; /* half a header, then 'I' of the real one */
    size_t k = 0;
    memcpy(in, junk, sizeof junk); k += sizeof junk;
    memcpy(in + k, buf, n); k += n;
    improv_parser_t p; memset(&p, 0, sizeof p);
    improv_frame_t f;
    CHECK_EQ(feed_all(&p, in, k, &f), 1);
    CHECK_EQ(f.type, IMPROV_TYPE_STATE);
    CHECK_EQ(f.len, 1);
    CHECK_EQ(f.data[0], 7);

    /* "IIMPROV": a stray 'I' right before the header must not swallow it */
    uint8_t in2[80] = { 'I' };
    memcpy(in2 + 1, buf, n);
    memset(&p, 0, sizeof p);
    CHECK_EQ(feed_all(&p, in2, n + 1, &f), 1);

    /* unknown version is skipped, not an error */
    buf[6] = 2;
    memset(&p, 0, sizeof p);
    CHECK_EQ(feed_all(&p, buf, n, &f), 0);
    buf[6] = IMPROV_VERSION;

    /* "IMPROVIMPROV\x01...": the 'I' that fails the version check starts the next header */
    uint8_t in3[90];
    memcpy(in3, "IMPROV", 6);
    memcpy(in3 + 6, buf, n);
    memset(&p, 0, sizeof p);
    CHECK_EQ(feed_all(&p, in3, 6 + n, &f), 1);
    CHECK_EQ(f.data[0], 7);
}

static void test_parse_wifi_rpc(void)
{
    uint8_t buf[128]; improv_parser_t p; memset(&p, 0, sizeof p);
    improv_frame_t f;
    size_t n = wifi_rpc(buf, sizeof buf, "Office", "p@ss word");
    CHECK(n > 0);
    CHECK_EQ(feed_all(&p, buf, n, &f), 1);
    char ssid[33], pass[65];
    CHECK(improv_parse_wifi(&f, ssid, pass));
    CHECK(strcmp(ssid, "Office") == 0);
    CHECK(strcmp(pass, "p@ss word") == 0);

    n = wifi_rpc(buf, sizeof buf, "Open", "");          /* open network */
    memset(&p, 0, sizeof p);
    CHECK_EQ(feed_all(&p, buf, n, &f), 1);
    CHECK(improv_parse_wifi(&f, ssid, pass) && pass[0] == 0 && strcmp(ssid, "Open") == 0);

    f.data[1] += 1;                                     /* inconsistent inner length */
    CHECK(!improv_parse_wifi(&f, ssid, pass));
    f.data[1] -= 1; f.type = IMPROV_TYPE_RESULT;        /* wrong packet type */
    CHECK(!improv_parse_wifi(&f, ssid, pass));
    f.type = IMPROV_TYPE_RPC; f.data[0] = 0x02;         /* other command */
    CHECK(!improv_parse_wifi(&f, ssid, pass));
}

static void test_oversized_ssid_rejected(void)
{
    char big[80]; memset(big, 'S', 33); big[33] = 0;
    uint8_t buf[200]; improv_parser_t p; memset(&p, 0, sizeof p);
    improv_frame_t f;
    char ssid[33] = "keep", pass[65] = "keep";
    size_t n = wifi_rpc(buf, sizeof buf, big, "pw");
    CHECK_EQ(feed_all(&p, buf, n, &f), 1);
    CHECK(!improv_parse_wifi(&f, ssid, pass));
    CHECK(strcmp(ssid, "keep") == 0 && strcmp(pass, "keep") == 0);

    memset(big, 'P', 65); big[65] = 0;                  /* over-long password too */
    n = wifi_rpc(buf, sizeof buf, "ok", big);
    memset(&p, 0, sizeof p);
    CHECK_EQ(feed_all(&p, buf, n, &f), 1);
    CHECK(!improv_parse_wifi(&f, ssid, pass));

    memset(big, 'S', 32); big[32] = 0;                  /* exactly 32 is fine */
    n = wifi_rpc(buf, sizeof buf, big, "pw");
    memset(&p, 0, sizeof p);
    CHECK_EQ(feed_all(&p, buf, n, &f), 1);
    CHECK(improv_parse_wifi(&f, ssid, pass) && strlen(ssid) == 32);
}

static int parser_data_is_zero(const improv_parser_t *p)
{
    const uint8_t *b = (const uint8_t *)&p->f;
    for (size_t i = 0; i < sizeof p->f; i++) if (b[i]) return 0;
    return 1;
}

/* A frame that carried a Wi-Fi password must not stay in the parser once it is done (flash coredump). */
static void test_parser_wiped_after_frame(void)
{
    uint8_t buf[128]; improv_parser_t p; memset(&p, 0, sizeof p);
    improv_frame_t f;
    size_t n = wifi_rpc(buf, sizeof buf, "Office", "p@ss word");
    CHECK_EQ(feed_all(&p, buf, n, &f), 1);
    CHECK(memmem(f.data, f.len, "p@ss word", 9) != NULL); /* the caller's copy has it */
    CHECK(parser_data_is_zero(&p));

    memset(&p, 0, sizeof p);
    buf[n - 1] ^= 0x55;                                   /* bad checksum: also wiped */
    CHECK_EQ(feed_all(&p, buf, n, &f), -1);
    CHECK(parser_data_is_zero(&p));

    buf[n - 1] ^= 0x55;                                   /* and the parser still works */
    CHECK_EQ(feed_all(&p, buf, n, &f), 1);
    CHECK(parser_data_is_zero(&p));
}

int main(void)
{
    test_build_then_parse_roundtrip();
    test_bad_checksum_rejected();
    test_garbage_before_header_skipped();
    test_parse_wifi_rpc();
    test_oversized_ssid_rejected();
    test_parser_wiped_after_frame();
    return g_failed ? 1 : 0;
}
