#include <stdint.h>
#include <string.h>
#include "check.h"
#include "codec_util.h"

static void test_b64url_roundtrip_0_to_70_bytes(void)
{
    uint8_t in[70], out[70];
    char enc[100];
    for (size_t n = 0; n <= 70; n++) {
        for (size_t i = 0; i < n; i++) in[i] = (uint8_t)(i * 37 + n * 11 + 0xF8);
        size_t len = b64url_encode(in, n, enc, sizeof enc);
        CHECK_EQ(len, (n * 4 + 2) / 3);
        CHECK(strchr(enc, '+') == NULL && strchr(enc, '/') == NULL && strchr(enc, '=') == NULL);
        CHECK_EQ(b64url_decode(enc, out, sizeof out), (int)n);
        CHECK(memcmp(in, out, n) == 0);
    }
    CHECK_EQ(b64url_encode((const uint8_t *)"ab", 2, enc, 3), 0); /* cap too small (needs 4) */
}

static void test_b64url_rejects_plus_slash_and_bad_len(void)
{
    uint8_t out[8];
    CHECK_EQ(b64url_decode("ab+", out, sizeof out), -1);
    CHECK_EQ(b64url_decode("ab/", out, sizeof out), -1);
    CHECK_EQ(b64url_decode("ab=", out, sizeof out), -1);  /* no padding accepted */
    CHECK_EQ(b64url_decode("a", out, sizeof out), -1);
    CHECK_EQ(b64url_decode("abcde", out, sizeof out), -1);
    CHECK_EQ(b64url_decode("QUJD", out, 2), -1);          /* overflow: 3 bytes into cap 2 */
}

static void test_json_escape_quotes_backslash_ctrl(void)
{
    char out[64];
    CHECK_EQ(json_escape("a\"b\\c\n", out, sizeof out), strlen("a\\\"b\\\\c\\u000a"));
    CHECK(strcmp(out, "a\\\"b\\\\c\\u000a") == 0);
    CHECK_EQ(json_escape("abcd", out, 4), 0);            /* needs 5 with NUL */
}

static void test_utf8_copy_never_splits(void)
{
    char out[16];
    CHECK_EQ(utf8_copy(out, sizeof out, "\xd0\x9f\xd1\x80\xd0\xb8", 3), 2); /* "П" */
    CHECK(strcmp(out, "\xd0\x9f") == 0);
    CHECK_EQ(utf8_copy(out, sizeof out, "\xf0\x9f\x98\x80x", 3), 0);       /* emoji does not fit */
    CHECK_EQ(out[0], '\0');
    CHECK_EQ(utf8_copy(out, 3, "abcdef", 6), 2);          /* cap-limited, NUL-terminated */
    CHECK(strcmp(out, "ab") == 0);
    CHECK_EQ(utf8_copy(out, 0, "abc", 3), 0);
}

static void test_iso8601(void)
{
    int64_t t = 0;
    const char *ok = "2026-11-13T09:30:00Z";
    CHECK(iso8601_to_epoch(ok, strlen(ok), &t));
    CHECK_EQ(t, 1794562200);
    CHECK(iso8601_to_epoch("2026-11-13T09:30:00.123Z", 24, &t));
    CHECK_EQ(t, 1794562200);
    CHECK(iso8601_to_epoch("2026-11-13T09:30:00+00:00", 25, &t));
    CHECK_EQ(t, 1794562200);
    CHECK(!iso8601_to_epoch("2026-13-01T00:00:00Z", 20, &t));
    CHECK(!iso8601_to_epoch("2026-11-13T09:30:00+05:00", 25, &t));
    CHECK(!iso8601_to_epoch("2026-02-29T00:00:00Z", 20, &t)); /* 2026 is not a leap year */
    CHECK(!iso8601_to_epoch("2026-11-13T09:30:00", 19, &t));  /* no zone */
    CHECK(!iso8601_to_epoch("2026-11-13T09:30:00Zx", 21, &t)); /* trailing junk */
}

static void test_uuid4_bits(void)
{
    uint8_t rnd[16];
    char out[37];
    for (int i = 0; i < 16; i++) rnd[i] = (uint8_t)(0xFF - i * 17);
    uuid4_format(rnd, out);
    CHECK_EQ(strlen(out), 36);
    CHECK_EQ(out[8], '-'); CHECK_EQ(out[13], '-'); CHECK_EQ(out[18], '-'); CHECK_EQ(out[23], '-');
    CHECK_EQ(out[14], '4');
    CHECK(strchr("89ab", out[19]) != NULL);
}

static void test_wifi_plain(void)
{
    char ssid[33], pass[65];
    const uint8_t ok[] = { 4, 'h', 'o', 'm', 'e', 4, 'p', 'a', 's', 's' };
    CHECK(wifi_plain_parse(ok, sizeof ok, ssid, pass));
    CHECK(strcmp(ssid, "home") == 0 && strcmp(pass, "pass") == 0);

    const uint8_t no_ssid[] = { 0, 0 };
    CHECK(!wifi_plain_parse(no_ssid, sizeof no_ssid, ssid, pass));

    const uint8_t trailing[] = { 4, 'h', 'o', 'm', 'e', 0, 0xAA };
    CHECK(!wifi_plain_parse(trailing, sizeof trailing, ssid, pass));

    uint8_t long_pass[1 + 4 + 1 + 65];
    long_pass[0] = 4; memcpy(long_pass + 1, "home", 4);
    long_pass[5] = 65; memset(long_pass + 6, 'p', 65);
    CHECK(!wifi_plain_parse(long_pass, sizeof long_pass, ssid, pass));
}

int main(void)
{
    test_b64url_roundtrip_0_to_70_bytes();
    test_b64url_rejects_plus_slash_and_bad_len();
    test_json_escape_quotes_backslash_ctrl();
    test_utf8_copy_never_splits();
    test_iso8601();
    test_uuid4_bits();
    test_wifi_plain();
    return g_failed ? 1 : 0;
}
