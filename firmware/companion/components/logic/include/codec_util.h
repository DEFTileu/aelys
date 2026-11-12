#pragma once
/* Small pure-C codecs shared by the protocol and identity code. No IDF, no libc beyond string.h/stddef. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* base64url without padding; NUL-terminated output. Returns chars written, 0 if cap is too small (out[0] = '\0' when cap > 0). */
size_t b64url_encode(const uint8_t *in, size_t n, char *out, size_t cap);
/* Returns bytes written, -1 on bad char, bad length or overflow. Accepts no padding. */
int    b64url_decode(const char *in, uint8_t *out, size_t cap);
/* Escapes " \ and bytes < 0x20 as \uXXXX. NUL-terminated. Returns chars written, 0 if it does not fit (out[0] = '\0' when cap > 0). */
size_t json_escape(const char *in, char *out, size_t cap);
/* Copies at most n bytes (and cap-1), never splits a UTF-8 code point, always NUL-terminates.
 * May read src[n]: src must be NUL-terminated or followed by a delimiter (a byte that is not a UTF-8 continuation). */
size_t utf8_copy(char *dst, size_t cap, const char *src, size_t n);
/* Accepts "YYYY-MM-DDTHH:MM:SS[.1-9 digits](Z|+00:00)" exactly, nothing else; fraction is ignored. */
bool   iso8601_to_epoch(const char *s, size_t n, int64_t *out);
/* RFC 4122 version 4 layout from 16 random bytes; out is 36 chars plus NUL. */
void   uuid4_format(const uint8_t rnd[16], char out[37]);
/* Plain Wi-Fi blob: [ssid_len 1..32][ssid][pass_len 0..64][pass], exact length. Outputs written only on success. */
bool   wifi_plain_parse(const uint8_t *p, size_t n, char ssid[33], char pass[65]);
