#include "action_journal.h"
#include <string.h>

#define HEADER_SIZE 240u
#define RECORD_SIZE 89u
#define CRC_OFFSET (ACTION_JOURNAL_BLOB_SIZE - 4u)

static size_t bounded_len(const char *s, size_t cap)
{
    size_t n = 0; while (n < cap && s[n]) ++n; return n;
}
static bool identifier(const char *s, size_t cap, bool empty_ok)
{
    size_t n = bounded_len(s, cap);
    if (n == cap || (!empty_ok && !n)) return false;
    for (size_t i = 0; i < n; ++i) {
        unsigned char c = (unsigned char)s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':')) return false;
    }
    return true;
}
static bool valid_binding(const action_journal_binding_t *b)
{
    if (!b || b->owner[0] != 4 || !identifier(b->device_id, sizeof b->device_id, false)) return false;
    size_t n = bounded_len(b->api_origin, sizeof b->api_origin), start;
    if (n == sizeof b->api_origin) return false;
    if (n > 8 && !memcmp(b->api_origin, "https://", 8)) start = 8;
    else if (n > 7 && !memcmp(b->api_origin, "http://", 7)) start = 7;
    else return false;
    for (size_t i = start; i < n; ++i) {
        unsigned char c = (unsigned char)b->api_origin[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '.' || c == ':' || c == '[' || c == ']')) return false;
    }
    return true;
}
static bool valid_uuid(const char id[37])
{
    if (id[36]) return false;
    for (size_t i = 0; i < 36; ++i) {
        char c = id[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return false; }
        else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return id[14] == '4' && (id[19] == '8' || id[19] == '9' || id[19] == 'a' || id[19] == 'b');
}
static bool valid_journal(const action_journal_t *j)
{
    if (!j || j->count > ACTION_JOURNAL_CAPACITY) return false;
    for (size_t i = 0; i < j->count; ++i) {
        const action_journal_record_t *r = &j->records[i];
        if (!valid_uuid(r->id) || r->kind < ACTION_JOURNAL_NOTIFICATION_READ || r->kind > ACTION_JOURNAL_TASK_COMPLETE) return false;
        bool needs_target = r->kind == ACTION_JOURNAL_NOTIFICATION_READ || r->kind == ACTION_JOURNAL_TASK_COMPLETE;
        if (!identifier(r->target, sizeof r->target, !needs_target) || (!needs_target && r->target[0])) return false;
        for (size_t k = 0; k < i; ++k)
            if (!strcmp(r->id, j->records[k].id) || (r->kind == j->records[k].kind && !strcmp(r->target, j->records[k].target))) return false;
    }
    return true;
}
static uint32_t crc32(const uint8_t *p, size_t n)
{
    uint32_t c = UINT32_MAX;
    while (n--) { c ^= *p++; for (unsigned i = 0; i < 8; ++i) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1u))); }
    return ~c;
}
static void put_le(uint8_t *p, uint64_t x, unsigned n)
{
    for (unsigned i = 0; i < n; ++i) p[i] = (uint8_t)(x >> (i * 8));
}
static uint64_t get_le(const uint8_t *p, unsigned n)
{
    uint64_t x = 0; for (unsigned i = 0; i < n; ++i) x |= (uint64_t)p[i] << (i * 8); return x;
}
size_t action_journal_encode(const action_journal_t *j, const action_journal_binding_t *b, uint8_t *out, size_t cap)
{
    if (!out || cap < ACTION_JOURNAL_BLOB_SIZE || !valid_binding(b) || !valid_journal(j)) return 0;
    uint8_t v[ACTION_JOURNAL_BLOB_SIZE] = {0};
    memcpy(v, "AJNL", 4); v[4] = 1; v[5] = (uint8_t)j->count;
    memcpy(v + 6, b->owner, 65); memcpy(v + 71, b->device_id, strlen(b->device_id));
    memcpy(v + 111, b->api_origin, strlen(b->api_origin));
    for (size_t i = 0; i < j->count; ++i) {
        uint8_t *p = v + HEADER_SIZE + i * RECORD_SIZE; const action_journal_record_t *r = &j->records[i];
        memcpy(p, r->id, 36); p[36] = (uint8_t)r->kind; memcpy(p + 37, r->target, strlen(r->target));
        put_le(p + 77, r->lost_rev, 4); put_le(p + 81, r->epoch, 8);
    }
    put_le(v + CRC_OFFSET, crc32(v, CRC_OFFSET), 4); memcpy(out, v, sizeof v); return sizeof v;
}
bool action_journal_decode(const uint8_t *blob, size_t size, const action_journal_binding_t *active, action_journal_t *out)
{
    if (!blob || !out || !valid_binding(active) || size != ACTION_JOURNAL_BLOB_SIZE ||
        memcmp(blob, "AJNL", 4) || blob[4] != 1 || blob[5] > ACTION_JOURNAL_CAPACITY ||
        get_le(blob + CRC_OFFSET, 4) != crc32(blob, CRC_OFFSET)) return false;
    action_journal_t j = {0}; j.count = blob[5];
    for (size_t i = 0; i < j.count; ++i) {
        const uint8_t *p = blob + HEADER_SIZE + i * RECORD_SIZE; action_journal_record_t *r = &j.records[i];
        memcpy(r->id, p, 36); r->kind = (action_journal_kind_t)p[36]; memcpy(r->target, p + 37, 40);
        r->lost_rev = (uint32_t)get_le(p + 77, 4); r->epoch = get_le(p + 81, 8);
    }
    uint8_t canonical[ACTION_JOURNAL_BLOB_SIZE];
    if (!action_journal_encode(&j, active, canonical, sizeof canonical) || memcmp(blob, canonical, sizeof canonical)) return false;
    *out = j; return true;
}
