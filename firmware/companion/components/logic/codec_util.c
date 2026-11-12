#include <string.h>
#include "codec_util.h"

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

static int b64_val(char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-') return 62;
    if (c == '_') return 63;
    return -1;
}

size_t b64url_encode(const uint8_t *in, size_t n, char *out, size_t cap)
{
    size_t len = (n * 4 + 2) / 3;
    if (cap < len + 1) return 0;
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16;
        if (i + 1 < n) v |= (uint32_t)in[i + 1] << 8;
        if (i + 2 < n) v |= in[i + 2];
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        if (i + 1 < n) out[o++] = B64[(v >> 6) & 63];
        if (i + 2 < n) out[o++] = B64[v & 63];
    }
    out[o] = '\0';
    return o;
}

int b64url_decode(const char *in, uint8_t *out, size_t cap)
{
    size_t n = strlen(in);
    if (n % 4 == 1) return -1;
    size_t bytes = n / 4 * 3 + (n % 4 == 2 ? 1 : n % 4 == 3 ? 2 : 0);
    if (bytes > cap) return -1;
    size_t o = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (size_t i = 0; i < n; i++) {
        int v = b64_val(in[i]);
        if (v < 0) return -1;
        acc = (acc << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (uint8_t)(acc >> bits);
        }
    }
    return (int)o;
}

size_t json_escape(const char *in, char *out, size_t cap)
{
    static const char HEX[] = "0123456789abcdef";
    size_t o = 0;
    for (const char *p = in; *p; p++) {
        unsigned char c = (unsigned char)*p;
        size_t need = (c == '"' || c == '\\') ? 2 : (c < 0x20) ? 6 : 1;
        if (o + need + 1 > cap) return 0;
        if (need == 2)      { out[o++] = '\\'; out[o++] = (char)c; }
        else if (need == 6) { out[o++] = '\\'; out[o++] = 'u'; out[o++] = '0'; out[o++] = '0';
                              out[o++] = HEX[c >> 4]; out[o++] = HEX[c & 15]; }
        else                { out[o++] = (char)c; }
    }
    if (o + 1 > cap) return 0;
    out[o] = '\0';
    return o;
}

size_t utf8_copy(char *dst, size_t cap, const char *src, size_t n)
{
    if (cap == 0) return 0;
    size_t k = 0;
    while (k < n && k < cap - 1 && src[k]) k++;
    /* src[k] is in bounds: k never passes the terminating NUL. Back off if it is a continuation byte. */
    while (k > 0 && ((unsigned char)src[k] & 0xC0) == 0x80) k--;
    memcpy(dst, src, k);
    dst[k] = '\0';
    return k;
}

static bool digits(const char *s, size_t n, int *v)
{
    *v = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') return false;
        *v = *v * 10 + (s[i] - '0');
    }
    return true;
}

/* Days since 1970-01-01 (Howard Hinnant's days_from_civil). */
static int64_t days_from_civil(int64_t y, unsigned m, unsigned d)
{
    y -= m <= 2;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    unsigned yoe = (unsigned)(y - era * 400);
    unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int64_t)doe - 719468;
}

bool iso8601_to_epoch(const char *s, size_t n, int64_t *out)
{
    /* base 19 chars + optional ".fff" + zone ("Z" or "+00:00") */
    if (n < 20 || s[4] != '-' || s[7] != '-' || s[10] != 'T' || s[13] != ':' || s[16] != ':') return false;
    size_t i = 19;
    if (n >= i + 4 && s[i] == '.') i += 4;
    size_t zone = n - i;
    if (!((zone == 1 && s[i] == 'Z') || (zone == 6 && memcmp(s + i, "+00:00", 6) == 0))) return false;
    int y, mo, d, h, mi, sec;
    if (!digits(s, 4, &y) || !digits(s + 5, 2, &mo) || !digits(s + 8, 2, &d) ||
        !digits(s + 11, 2, &h) || !digits(s + 14, 2, &mi) || !digits(s + 17, 2, &sec)) return false;
    if (i == 23) { int frac; if (!digits(s + 20, 3, &frac)) return false; } /* i == 23 implies s[19] == '.' */
    static const int MDAYS[] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    bool leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    int mdays = (mo == 2 && leap) ? 29 : (mo >= 1 && mo <= 12 ? MDAYS[mo - 1] : 0);
    if (mdays == 0 || d < 1 || d > mdays || h > 23 || mi > 59 || sec > 59) return false;
    *out = days_from_civil(y, (unsigned)mo, (unsigned)d) * 86400 + h * 3600 + mi * 60 + sec;
    return true;
}

void uuid4_format(const uint8_t rnd[16], char out[37])
{
    static const char HEX[] = "0123456789abcdef";
    uint8_t b[16];
    memcpy(b, rnd, 16);
    b[6] = (uint8_t)((b[6] & 0x0F) | 0x40);  /* version 4 */
    b[8] = (uint8_t)((b[8] & 0x3F) | 0x80);  /* RFC 4122 variant */
    size_t o = 0;
    for (int i = 0; i < 16; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) out[o++] = '-';
        out[o++] = HEX[b[i] >> 4];
        out[o++] = HEX[b[i] & 15];
    }
    out[o] = '\0';
}

bool wifi_plain_parse(const uint8_t *p, size_t n, char ssid[33], char pass[65])
{
    if (!p || n < 2) return false;
    size_t sl = p[0];
    if (sl < 1 || sl > 32 || n < 1 + sl + 1) return false;
    size_t pl = p[1 + sl];
    if (pl > 64 || n != 1 + sl + 1 + pl) return false;
    memcpy(ssid, p + 1, sl);
    ssid[sl] = '\0';
    memcpy(pass, p + 1 + sl + 1, pl);
    pass[pl] = '\0';
    return true;
}
