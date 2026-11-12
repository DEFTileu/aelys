#include <string.h>
#include "improv.h"

static const char HDR[6] = { 'I', 'M', 'P', 'R', 'O', 'V' };
enum { S_HDR, S_VER, S_TYPE, S_LEN, S_DATA, S_SUM };

static void restart(improv_parser_t *p) { p->st = S_HDR; p->idx = 0; p->sum = 0; }

int improv_feed(improv_parser_t *p, uint8_t b, improv_frame_t *out)
{
    switch (p->st) {
    case S_HDR:
        if (b == (uint8_t)HDR[p->idx]) {
            p->sum += b;
            if (++p->idx == sizeof HDR) p->st = S_VER;
        } else {
            restart(p);
            if (b == (uint8_t)HDR[0]) { p->sum = b; p->idx = 1; } /* the mismatching byte may start a header */
        }
        return 0;
    case S_VER:
        if (b != IMPROV_VERSION) { restart(p); return 0; }
        p->sum += b; p->st = S_TYPE;
        return 0;
    case S_TYPE:
        p->f.type = b; p->sum += b; p->st = S_LEN;
        return 0;
    case S_LEN:
        p->f.len = b; p->sum += b; p->idx = 0;
        p->st = b ? S_DATA : S_SUM;
        return 0;
    case S_DATA:
        p->f.data[p->idx++] = b; p->sum += b;
        if (p->idx == p->f.len) p->st = S_SUM;
        return 0;
    default: { /* S_SUM */
        bool ok = b == p->sum;
        if (ok && out) *out = p->f;
        restart(p);
        return ok ? 1 : -1;
    }
    }
}

size_t improv_build(uint8_t type, const uint8_t *data, size_t len, uint8_t *buf, size_t cap)
{
    if (len > 255 || (len && !data) || !buf || cap < 10 + len) return 0;
    memcpy(buf, HDR, sizeof HDR);
    buf[6] = IMPROV_VERSION; buf[7] = type; buf[8] = (uint8_t)len;
    if (len) memcpy(buf + 9, data, len);
    uint8_t sum = 0;
    for (size_t i = 0; i < 9 + len; i++) sum += buf[i];
    buf[9 + len] = sum;
    return 10 + len;
}

bool improv_parse_wifi(const improv_frame_t *f, char ssid[33], char pass[65])
{
    if (f->type != IMPROV_TYPE_RPC || f->len < 4 || f->data[0] != IMPROV_RPC_WIFI) return false;
    if (f->data[1] != f->len - 2) return false;
    size_t sl = f->data[2];
    if (sl == 0 || sl > 32 || 3 + sl + 1 > f->len) return false;
    size_t pl = f->data[3 + sl];
    if (pl > 64 || 3 + sl + 1 + pl != f->len) return false;
    memcpy(ssid, &f->data[3], sl); ssid[sl] = '\0';
    memcpy(pass, &f->data[4 + sl], pl); pass[pl] = '\0';
    return true;
}
