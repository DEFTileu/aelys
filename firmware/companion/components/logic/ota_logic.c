#include <string.h>
#include "ota_logic.h"

#define URL_PREFIX "/api/v1/companion/firmware/"

int semver_parse(const char *s, uint16_t out[3])
{
    if (!s) return -1;
    for (int i = 0; i < 3; i++) {
        int digits = 0;
        uint16_t v = 0;
        while (s[digits] >= '0' && s[digits] <= '9' && digits < 4) v = (uint16_t)(v * 10 + (s[digits++] - '0'));
        if (digits < 1 || digits > 3) return -1;
        s += digits;
        if (i < 2) { if (*s++ != '.') return -1; }
        out[i] = v;
    }
    return *s ? -1 : 0;
}

int semver_cmp(const char *a, const char *b)
{
    uint16_t va[3], vb[3];
    bool oka = semver_parse(a, va) == 0, okb = semver_parse(b, vb) == 0;
    if (!oka || !okb) return (int)oka - (int)okb;
    for (int i = 0; i < 3; i++)
        if (va[i] != vb[i]) return va[i] > vb[i] ? 1 : -1;
    return 0;
}

static bool is_hex64(const char *s)
{
    if (strnlen(s, 65) != 64) return false;
    for (int i = 0; i < 64; i++)
        if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f') || (s[i] >= 'A' && s[i] <= 'F'))) return false;
    return true;
}

ota_verdict_t ota_decide(const char *running, const char *bad_version, const ota_meta_t *m, uint32_t slot_size)
{
    uint16_t v[3];
    if (!m || semver_parse(running, v) || memchr(m->version, 0, sizeof m->version) == NULL ||
        memchr(m->min_version, 0, sizeof m->min_version) == NULL || semver_parse(m->version, v) ||
        semver_parse(m->min_version, v) || !is_hex64(m->sha256))
        return OTA_BAD_META;
    if (memchr(m->url, 0, sizeof m->url) == NULL || strncmp(m->url, URL_PREFIX, sizeof URL_PREFIX - 1) != 0 ||
        strstr(m->url, "..") || strstr(m->url, "//") || strstr(m->url, "://"))
        return OTA_BAD_URL;
    if (m->size == 0 || m->size > slot_size) return OTA_BAD_SIZE;
    if (semver_cmp(m->version, running) <= 0) return OTA_UP_TO_DATE;
    if (semver_cmp(running, m->min_version) < 0) return OTA_TOO_OLD;
    if (bad_version && *bad_version && semver_cmp(m->version, bad_version) == 0) return OTA_KNOWN_BAD;
    return OTA_INSTALL;
}

void ota_confirm_start(ota_confirm_t *c, bool pending_verify, uint32_t now_ms, uint32_t window_ms)
{
    memset(c, 0, sizeof *c);
    c->pending = pending_verify;
    c->deadline_ms = now_ms + window_ms;
}

confirm_t ota_confirm_update(ota_confirm_t *c, uint8_t channel_event, uint32_t now_ms)
{
    if (!c->pending) return CONFIRM_VALID;
    if (channel_event == 1) c->got_ready = true;
    else if (channel_event == 2) c->got_snapshot = true;
    else if (channel_event == 3) c->sent_hello = true;
    if (c->got_ready && c->got_snapshot && c->sent_hello) { c->pending = false; return CONFIRM_VALID; }
    /* signed difference keeps the deadline correct across the 32-bit ms wrap */
    return (int32_t)(now_ms - c->deadline_ms) >= 0 ? CONFIRM_ROLLBACK : CONFIRM_WAIT;
}
