#include <string.h>
#include "ota_logic.h"
#include "check.h"

#define SLOT 4194304u
#define SHA "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

static ota_meta_t meta(const char *ver, const char *min, const char *url, uint32_t size)
{
    ota_meta_t m;
    memset(&m, 0, sizeof m);
    strcpy(m.version, ver);
    strcpy(m.min_version, min);
    strcpy(m.url, url);
    strcpy(m.sha256, SHA);
    m.size = size;
    return m;
}

#define URL "/api/v1/companion/firmware/0.3.0"

static void test_semver_orders_numerically(void)
{
    uint16_t v[3];
    CHECK(semver_cmp("0.10.0", "0.9.9") > 0);
    CHECK(semver_cmp("0.9.9", "0.10.0") < 0);
    CHECK_EQ(semver_cmp("1.2.3", "1.2.3"), 0);
    CHECK(semver_cmp("1.2.3", "bad") > 0); /* bad input sorts lowest */
    CHECK_EQ(semver_parse("1.20.300", v), 0);
    CHECK(v[0] == 1 && v[1] == 20 && v[2] == 300);
    CHECK_EQ(semver_parse("1.2", v), -1);
    CHECK_EQ(semver_parse("a.b.c", v), -1);
    CHECK_EQ(semver_parse("1.2.3.4", v), -1);
    CHECK_EQ(semver_parse("1000.0.0", v), -1);
    CHECK_EQ(semver_parse("", v), -1);
    CHECK_EQ(semver_parse(NULL, v), -1);
}

static void test_install_newer(void)
{
    ota_meta_t m = meta("0.3.0", "0.1.0", URL, 1000000);
    CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_INSTALL);
    CHECK_EQ(ota_decide("0.2.0", "", &m, SLOT), OTA_INSTALL);
    m.size = SLOT;
    CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_INSTALL);
}

static void test_up_to_date_and_older(void)
{
    ota_meta_t m = meta("0.2.0", "0.1.0", URL, 1000);
    CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_UP_TO_DATE);
    CHECK_EQ(ota_decide("0.3.0", NULL, &m, SLOT), OTA_UP_TO_DATE);
}

static void test_too_old_for_min_version(void)
{
    ota_meta_t m = meta("0.5.0", "0.3.0", URL, 1000);
    CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_TOO_OLD);
    CHECK_EQ(ota_decide("0.3.0", NULL, &m, SLOT), OTA_INSTALL);
}

static void test_bad_version_never_retried(void)
{
    ota_meta_t m = meta("0.3.0", "0.1.0", URL, 1000);
    CHECK_EQ(ota_decide("0.2.0", "0.3.0", &m, SLOT), OTA_KNOWN_BAD);
    m = meta("0.3.1", "0.1.0", URL, 1000);
    CHECK_EQ(ota_decide("0.2.0", "0.3.0", &m, SLOT), OTA_INSTALL);
}

static void test_bad_meta(void)
{
    ota_meta_t m = meta("0.3.0", "0.1.0", URL, 1000);
    CHECK_EQ(ota_decide("bad", NULL, &m, SLOT), OTA_BAD_META);
    m = meta("x", "0.1.0", URL, 1000);
    CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_BAD_META);
    m = meta("0.3.0", "", URL, 1000);
    CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_BAD_META);
    m = meta("0.3.0", "0.1.0", URL, 1000);
    m.sha256[10] = 'g';
    CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_BAD_META);
    m = meta("0.3.0", "0.1.0", URL, 1000);
    m.sha256[63] = '\0'; /* 63 chars */
    CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_BAD_META);
}

static void test_url_must_be_own_api_path(void)
{
    const char *bad[] = {"https://evil/x", "http://evil/x", "//host/x",
                         "/api/v1/companion/firmware/../../x", "/other", "",
                         "/api/v1/companion/firmware//x",
                         "/api/v1/companion/firmware/x?u=http://evil",
                         "/api/v1/companion/firmware/%2e%2e/x", "/api/v1/companion/firmware/0.3.0\r\nX: y",
                         "/api/v1/companion/firmware/a\\b", "/api/v1/companion/firmware/a b",
                         "/api/v1/companion/firmware/0.3.0?x=1", "/api/v1/companion/firmware/"};
    for (unsigned i = 0; i < sizeof bad / sizeof *bad; i++) {
        ota_meta_t m = meta("0.3.0", "0.1.0", bad[i], 1000);
        CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_BAD_URL);
    }
    ota_meta_t ok = meta("0.3.0", "0.1.0", "/api/v1/companion/firmware/0.3.0/image", 1000);
    CHECK_EQ(ota_decide("0.2.0", NULL, &ok, SLOT), OTA_INSTALL);
}

static void test_size_limits(void)
{
    ota_meta_t m = meta("0.3.0", "0.1.0", URL, 0);
    CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_BAD_SIZE);
    m.size = SLOT + 1;
    CHECK_EQ(ota_decide("0.2.0", NULL, &m, SLOT), OTA_BAD_SIZE);
}

static void test_confirm_needs_all_three_events(void)
{
    ota_confirm_t c;
    ota_confirm_start(&c, true, 1000, 60000);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_TICK, 1100), CONFIRM_WAIT);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_HELLO_SENT, 1200), CONFIRM_WAIT);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_READY, 1300), CONFIRM_WAIT);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_SNAPSHOT, 1400), CONFIRM_VALID);
    /* any order */
    ota_confirm_start(&c, true, 0, 60000);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_SNAPSHOT, 10), CONFIRM_WAIT);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_HELLO_SENT, 20), CONFIRM_WAIT);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_READY, 30), CONFIRM_VALID);
}

static void test_confirm_rolls_back_after_window(void)
{
    ota_confirm_t c;
    ota_confirm_start(&c, true, 1000, 60000);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_READY, 5000), CONFIRM_WAIT);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_TICK, 60999), CONFIRM_WAIT);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_TICK, 61000), CONFIRM_ROLLBACK);
    /* wraparound of the 32-bit ms clock */
    ota_confirm_start(&c, true, 0xFFFFFF00u, 1000);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_TICK, 0xFFFFFF10u), CONFIRM_WAIT);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_TICK, 0x000002E7u), CONFIRM_WAIT);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_TICK, 0x000002E8u), CONFIRM_ROLLBACK);
}

static void test_not_pending_never_rolls_back(void)
{
    ota_confirm_t c;
    ota_confirm_start(&c, false, 1000, 10);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_TICK, 1000000), CONFIRM_VALID);
    CHECK_EQ(ota_confirm_update(&c, OTA_EV_TICK, 2000000), CONFIRM_VALID);
}

int main(void)
{
    test_semver_orders_numerically();
    test_install_newer();
    test_up_to_date_and_older();
    test_too_old_for_min_version();
    test_bad_version_never_retried();
    test_bad_meta();
    test_url_must_be_own_api_path();
    test_size_limits();
    test_confirm_needs_all_three_events();
    test_confirm_rolls_back_after_window();
    test_not_pending_never_rolls_back();
    return g_failed ? 1 : 0;
}
