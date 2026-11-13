#include <string.h>
#include "store_codec.h"

/* No padding anywhere, so the in-memory layout is the blob layout. */
_Static_assert(sizeof(owner_info_t) == 33 + 24 + 33 + 49 + 97 + 65 + 97 + 2 * 33 + 2 * 17 + 2 * 24 + 2 + 4, "owner layout");
_Static_assert(sizeof(wifi_list_t) == 1 + WIFI_MAX * (33 + 65), "wifi layout");
_Static_assert(sizeof(pair_rec_t) == 40 + 129 + 32, "pair layout");
_Static_assert(sizeof(snap_t) == 1088, "snap layout changed: bump STORE_SNAP_VERSION, then this number");

uint32_t store_crc32(const uint8_t *p, size_t n)
{
    static const uint32_t tab[16] = {
        0x00000000, 0x1DB71064, 0x3B6E20C8, 0x26D930AC, 0x76DC4190, 0x6B6B51F4, 0x4DB26158, 0x5005713C,
        0xEDB88320, 0xF00F9344, 0xD6D6A3E8, 0xCB61B38C, 0x9B64C2B0, 0x86D3D2D4, 0xA00AE278, 0xBDBDF21C };
    uint32_t c = 0xFFFFFFFFu;
    while (n--) {
        c ^= *p++;
        c = (c >> 4) ^ tab[c & 15];
        c = (c >> 4) ^ tab[c & 15];
    }
    return ~c;
}

static size_t seal(uint8_t ver, const void *payload, size_t plen, uint8_t *buf, size_t cap)
{
    size_t total = 1 + plen + 4;
    if (!buf || cap < total) return 0;
    buf[0] = ver;
    memcpy(buf + 1, payload, plen);
    uint32_t c = store_crc32(buf, 1 + plen);
    for (int i = 0; i < 4; i++) buf[1 + plen + i] = (uint8_t)(c >> (8 * i));
    return total;
}

/* Returns the payload pointer, or NULL on bad length/version/CRC. */
static const uint8_t *unseal(uint8_t ver, const uint8_t *buf, size_t len, size_t plen)
{
    if (!buf || len != 1 + plen + 4 || buf[0] != ver) return NULL;
    uint32_t want = 0;
    for (int i = 0; i < 4; i++) want |= (uint32_t)buf[1 + plen + i] << (8 * i);
    return store_crc32(buf, 1 + plen) == want ? buf + 1 : NULL;
}

#define TERM(f) ((f)[sizeof(f) - 1] = '\0')
static void term_owner(owner_info_t *o)
{
    TERM(o->name); TERM(o->phone); TERM(o->telegram); TERM(o->qr_url); TERM(o->message); TERM(o->med_note);
    TERM(o->email);
    for (int i = 0; i < 2; i++) { TERM(o->ice_name[i]); TERM(o->ice_rel[i]); TERM(o->ice_phone[i]); }
}

size_t store_encode_owner(const owner_info_t *in, uint8_t *buf, size_t cap)
{
    return seal(STORE_OWNER_VERSION, in, sizeof *in, buf, cap);
}

bool store_decode_owner(const uint8_t *buf, size_t len, owner_info_t *out)
{
    const uint8_t *p = unseal(STORE_OWNER_VERSION, buf, len, sizeof *out);
    if (!p) return false;
    memcpy(out, p, sizeof *out);
    term_owner(out);
    return true;
}

size_t store_encode_wifi(const wifi_list_t *in, uint8_t *buf, size_t cap)
{
    return seal(STORE_WIFI_VERSION, in, sizeof *in, buf, cap);
}

bool store_decode_wifi(const uint8_t *buf, size_t len, wifi_list_t *out)
{
    const uint8_t *p = unseal(STORE_WIFI_VERSION, buf, len, sizeof *out);
    if (!p || p[0] > WIFI_MAX) return false;
    memcpy(out, p, sizeof *out);
    for (int i = 0; i < WIFI_MAX; i++) { TERM(out->net[i].ssid); TERM(out->net[i].pass); }
    return true;
}

size_t store_encode_lost(const lost_state_t *in, uint8_t *buf, size_t cap)
{
    uint8_t p[STORE_LOST_PAYLOAD];
    p[0] = in->on ? 1 : 0;
    memcpy(p + 1, &in->rev, sizeof in->rev);
    memcpy(p + 1 + sizeof in->rev, &in->shown, sizeof in->shown);
    return seal(STORE_LOST_VERSION, p, sizeof p, buf, cap);
}

bool store_decode_lost(const uint8_t *buf, size_t len, lost_state_t *out)
{
    const uint8_t *p = unseal(STORE_LOST_VERSION, buf, len, STORE_LOST_PAYLOAD);
    if (!p) return false;
    out->on = p[0] != 0;
    memcpy(&out->rev, p + 1, sizeof out->rev);
    memcpy(&out->shown, p + 1 + sizeof out->rev, sizeof out->shown);
    term_owner(&out->shown);
    return true;
}

size_t store_encode_settings(const settings_t *in, uint8_t *buf, size_t cap)
{
    uint8_t p[STORE_SETTINGS_PAYLOAD];
    p[0] = in->brightness;
    memcpy(p + 1, &in->rev, sizeof in->rev);
    return seal(STORE_SETTINGS_VERSION, p, sizeof p, buf, cap);
}

bool store_decode_settings(const uint8_t *buf, size_t len, settings_t *out)
{
    const uint8_t *p = unseal(STORE_SETTINGS_VERSION, buf, len, STORE_SETTINGS_PAYLOAD);
    if (!p || p[0] < BRIGHTNESS_MIN || p[0] > BRIGHTNESS_MAX) return false;
    out->brightness = p[0];
    memcpy(&out->rev, p + 1, sizeof out->rev);
    return true;
}

size_t store_encode_pair(const pair_rec_t *in, uint8_t *buf, size_t cap)
{
    return seal(STORE_PAIR_VERSION, in, sizeof *in, buf, cap);
}

bool store_decode_pair(const uint8_t *buf, size_t len, pair_rec_t *out)
{
    const uint8_t *p = unseal(STORE_PAIR_VERSION, buf, len, sizeof *out);
    if (!p) return false;
    memcpy(out, p, sizeof *out);
    TERM(out->device_id); TERM(out->api_url);
    return true;
}

bool wifi_list_upsert(wifi_list_t *l, const char *ssid, const char *pass)
{
    if (!ssid || !pass || !*ssid) return false;
    if (strlen(ssid) >= sizeof l->net[0].ssid || strlen(pass) >= sizeof l->net[0].pass) return false;

    wifi_cred_t *slot = NULL;
    for (int i = 0; i < l->n && i < WIFI_MAX; i++)
        if (strcmp(l->net[i].ssid, ssid) == 0) { slot = &l->net[i]; break; }
    if (!slot) {
        if (l->n >= WIFI_MAX) {
            memmove(&l->net[0], &l->net[1], (WIFI_MAX - 1) * sizeof l->net[0]);
            l->n = WIFI_MAX - 1;
        }
        slot = &l->net[l->n++];
    }
    memset(slot, 0, sizeof *slot);
    strcpy(slot->ssid, ssid);
    strcpy(slot->pass, pass);
    return true;
}

bool wifi_list_remove(wifi_list_t *l, const char *ssid)
{
    if (!ssid || !*ssid) return false;
    for (int i = 0; i < l->n && i < WIFI_MAX; i++) {
        if (strcmp(l->net[i].ssid, ssid) != 0) continue;
        memmove(&l->net[i], &l->net[i + 1], (size_t)(l->n - 1 - i) * sizeof l->net[0]);
        memset(&l->net[--l->n], 0, sizeof l->net[0]); /* no password left behind */
        return true;
    }
    return false;
}

bool wifi_list_reorder(wifi_list_t *l, const char ssids[][33], int n)
{
    wifi_list_t out;
    memset(&out, 0, sizeof out);
    bool used[WIFI_MAX] = { false };
    for (int k = 0; k < n && out.n < l->n; k++)
        for (int i = 0; i < l->n && i < WIFI_MAX; i++)
            if (!used[i] && strncmp(l->net[i].ssid, ssids[k], 33) == 0) { used[i] = true; out.net[out.n++] = l->net[i]; break; }
    for (int i = 0; i < l->n && i < WIFI_MAX; i++)
        if (!used[i]) out.net[out.n++] = l->net[i];
    bool changed = memcmp(&out, l, sizeof out) != 0;
    if (changed) *l = out;
    for (volatile uint8_t *w = (volatile uint8_t *)&out; w < (volatile uint8_t *)(&out + 1); w++) *w = 0; /* passwords: not optimised away */
    return changed;
}

size_t store_encode_snap(const snap_t *in, uint8_t *buf, size_t cap)
{
    return seal(STORE_SNAP_VERSION, in, sizeof *in, buf, cap);
}

bool store_decode_snap(const uint8_t *buf, size_t len, snap_t *out)
{
    const uint8_t *p = unseal(STORE_SNAP_VERSION, buf, len, sizeof *out);
    if (!p) return false;
    snap_t s;
    memcpy(&s, p, sizeof s);
    if (s.n_notices > 5 || s.focus.status > FOCUS_PAUSED) return false;
    TERM(s.task.id); TERM(s.task.title); TERM(s.event.id); TERM(s.event.title);
    TERM(s.focus.id); TERM(s.focus.mode);
    for (int i = 0; i < 5; i++) { TERM(s.notices[i].id); TERM(s.notices[i].kind); TERM(s.notices[i].title); }
    *out = s;
    return true;
}
