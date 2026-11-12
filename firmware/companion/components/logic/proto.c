/* Companion channel codec. See proto.h and docs/companion-protocol.md. Pure C, no allocation. */
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#define JSMN_STATIC
#define JSMN_PARENT_LINKS
#define JSMN_STRICT
#include "jsmn.h"
#include "codec_util.h"
#include "proto.h"

#define MAX_FRAME 4096
#define MAX_TOKENS 256

/* ------------------------------------------------------------------ parsing */

typedef struct { const char *js; const jsmntok_t *t; } P;

enum { S_REQ = 1, S_TRUNC = 2 }; /* S_TRUNC: cut an over-long value on a UTF-8 boundary instead of rejecting it */

/* index after the subtree rooted at token i */
static int skip(const P *p, int i)
{
    int pending = 1;
    while (pending > 0) pending += p->t[i++].size - 1;
    return i;
}

/* value token of key under object token obj; -1 if obj is not an object or the key is missing */
static int find(const P *p, int obj, const char *key)
{
    if (obj < 0 || p->t[obj].type != JSMN_OBJECT) return -1;
    size_t kl = strlen(key);
    int i = obj + 1;
    for (int c = 0; c < p->t[obj].size; c++) {
        const jsmntok_t *k = &p->t[i];
        if ((size_t)(k->end - k->start) == kl && memcmp(p->js + k->start, key, kl) == 0) return i + 1;
        i = skip(p, i + 1);
    }
    return -1;
}

static bool is_null(const P *p, int i) { return p->t[i].type == JSMN_PRIMITIVE && p->js[p->t[i].start] == 'n'; }

static bool hex4(const char *s, const char *e, uint32_t *v)
{
    if (e - s < 4) return false;
    *v = 0;
    for (int i = 0; i < 4; i++) {
        char c = s[i];
        uint32_t d = c >= '0' && c <= '9' ? (uint32_t)(c - '0') : c >= 'a' && c <= 'f' ? (uint32_t)(c - 'a' + 10)
                   : c >= 'A' && c <= 'F' ? (uint32_t)(c - 'A' + 10) : 16u;
        if (d > 15) return false;
        *v = *v << 4 | d;
    }
    return true;
}

static size_t utf8_encode(uint32_t cp, char u[4])
{
    if (cp < 0x80)    { u[0] = (char)cp; return 1; }
    if (cp < 0x800)   { u[0] = (char)(0xC0 | cp >> 6); u[1] = (char)(0x80 | (cp & 63)); return 2; }
    if (cp < 0x10000) { u[0] = (char)(0xE0 | cp >> 12); u[1] = (char)(0x80 | (cp >> 6 & 63)); u[2] = (char)(0x80 | (cp & 63)); return 3; }
    u[0] = (char)(0xF0 | cp >> 18); u[1] = (char)(0x80 | (cp >> 12 & 63));
    u[2] = (char)(0x80 | (cp >> 6 & 63)); u[3] = (char)(0x80 | (cp & 63));
    return 4;
}

/* Decodes the JSON string token i into dst (cap >= 1), writing whole code points only. Returns the full decoded
 * length (>= cap means it was cut), or -1 if the token is not a string or has a bad escape. */
static int jstr(const P *p, int i, char *dst, size_t cap)
{
    dst[0] = '\0';
    if (p->t[i].type != JSMN_STRING) return -1;
    const char *s = p->js + p->t[i].start, *e = p->js + p->t[i].end;
    size_t total = 0, pos = 0;
    bool full = false;
    while (s < e) {
        char u[4];
        size_t k;
        unsigned char c = (unsigned char)*s;
        if (c != '\\') {                                /* raw UTF-8: copy one whole sequence */
            k = c < 0xC0 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
            if (k > (size_t)(e - s)) k = (size_t)(e - s);
            memcpy(u, s, k);
            s += k;
        } else {
            if (e - s < 2) return -1;
            char x = s[1];
            s += 2;
            switch (x) {
            case '"': case '\\': case '/': u[0] = x; k = 1; break;
            case 'b': u[0] = '\b'; k = 1; break;
            case 'f': u[0] = '\f'; k = 1; break;
            case 'n': u[0] = '\n'; k = 1; break;
            case 'r': u[0] = '\r'; k = 1; break;
            case 't': u[0] = '\t'; k = 1; break;
            case 'u': {
                uint32_t cp, lo;
                if (!hex4(s, e, &cp) || cp == 0) return -1;
                s += 4;
                if (cp >= 0xD800 && cp < 0xDC00) {      /* high surrogate: needs a low one right after it */
                    if (e - s >= 6 && s[0] == '\\' && s[1] == 'u' && hex4(s + 2, e, &lo) && lo >= 0xDC00 && lo < 0xE000) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        s += 6;
                    } else cp = 0xFFFD;
                } else if (cp >= 0xDC00 && cp < 0xE000) cp = 0xFFFD; /* lone low surrogate */
                k = utf8_encode(cp, u);
                break;
            }
            default: return -1;
            }
        }
        total += k;
        if (!full && pos + k < cap) { memcpy(dst + pos, u, k); pos += k; } else full = true;
    }
    dst[pos] = '\0';
    return (int)total;
}

/* string field: absent or null -> "" (false if S_REQ); wrong type / bad escape / too long without S_TRUNC -> false */
static bool get_str(const P *p, int obj, const char *key, char *dst, size_t cap, int fl)
{
    dst[0] = '\0';
    int v = find(p, obj, key);
    if (v < 0 || is_null(p, v)) return !(fl & S_REQ);
    int n = jstr(p, v, dst, cap);
    return n >= 0 && ((fl & S_TRUNC) || (size_t)n < cap);
}

static bool get_bool(const P *p, int obj, const char *key, bool *dst, int fl) /* *dst keeps its preset default when absent */
{
    int v = find(p, obj, key);
    if (v < 0 || is_null(p, v)) return !(fl & S_REQ);
    if (p->t[v].type != JSMN_PRIMITIVE) return false;
    char c = p->js[p->t[v].start];
    if (c != 't' && c != 'f') return false;
    *dst = c == 't';
    return true;
}

/* integer field: absent or null -> *dst unchanged (false if S_REQ); not an integer -> false */
static bool get_int(const P *p, int obj, const char *key, int64_t *dst, int fl)
{
    int v = find(p, obj, key);
    if (v < 0 || is_null(p, v)) return !(fl & S_REQ);
    const jsmntok_t *t = &p->t[v];
    if (t->type != JSMN_PRIMITIVE) return false;
    const char *s = p->js + t->start;
    int n = t->end - t->start, i = n > 0 && s[0] == '-';
    if (n - i < 1 || n - i > 15) return false;
    int64_t r = 0;
    for (; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') return false;
        r = r * 10 + (s[i] - '0');
    }
    *dst = s[0] == '-' ? -r : r;
    return true;
}

static bool get_count(const P *p, int obj, const char *key, int16_t *dst) /* clamps to 0..32767 */
{
    int64_t v = INT64_MIN; /* untouched = absent: keep the caller's default */
    if (!get_int(p, obj, key, &v, 0)) return false;
    if (v != INT64_MIN) *dst = (int16_t)(v < 0 ? 0 : v > 32767 ? 32767 : v);
    return true;
}

static bool get_time(const P *p, int obj, const char *key, int64_t *dst, int fl)
{
    int v = find(p, obj, key);
    if (v < 0 || is_null(p, v)) return !(fl & S_REQ);
    const jsmntok_t *t = &p->t[v];
    return t->type == JSMN_STRING && iso8601_to_epoch(p->js + t->start, (size_t)(t->end - t->start), dst);
}

/* object field: absent or null -> *idx = -1; present but not an object -> false */
static bool get_obj(const P *p, int obj, const char *key, int *idx)
{
    int v = find(p, obj, key);
    *idx = -1;
    if (v < 0 || is_null(p, v)) return true;
    if (p->t[v].type != JSMN_OBJECT) return false;
    *idx = v;
    return true;
}

static bool parse_task(const P *p, int o, snap_task_t *t)
{
    return get_str(p, o, "id", t->id, sizeof t->id, S_REQ) && get_str(p, o, "title", t->title, sizeof t->title, S_REQ | S_TRUNC) &&
           get_time(p, o, "due_at", &t->due, S_REQ);
}

static bool parse_event(const P *p, int o, snap_event_t *e)
{
    e->has_end = false;
    if (!get_str(p, o, "id", e->id, sizeof e->id, S_REQ) || !get_str(p, o, "title", e->title, sizeof e->title, S_REQ | S_TRUNC) ||
        !get_time(p, o, "starts_at", &e->starts, S_REQ) || !get_bool(p, o, "all_day", &e->all_day, 0)) return false;
    int v = find(p, o, "ends_at");
    if (v >= 0 && !is_null(p, v)) { e->has_end = true; return get_time(p, o, "ends_at", &e->ends, S_REQ); }
    return true;
}

static bool parse_notice(const P *p, int o, snap_notice_t *n)
{
    return get_str(p, o, "id", n->id, sizeof n->id, S_REQ) && get_str(p, o, "kind", n->kind, sizeof n->kind, S_REQ | S_TRUNC) &&
           get_str(p, o, "title", n->title, sizeof n->title, S_REQ | S_TRUNC) && get_time(p, o, "created_at", &n->created, S_REQ);
}

static bool parse_focus(const P *p, int o, snap_focus_t *f)
{
    char st[10];
    int64_t el = 0;
    if (!get_str(p, o, "id", f->id, sizeof f->id, S_REQ) || !get_str(p, o, "status", st, sizeof st, S_REQ) ||
        !get_str(p, o, "mode", f->mode, sizeof f->mode, S_REQ) || !get_time(p, o, "started_at", &f->started, S_REQ) ||
        !get_int(p, o, "elapsed_seconds", &el, S_REQ)) return false;
    f->status = strcmp(st, "active") == 0 ? FOCUS_ACTIVE : strcmp(st, "paused") == 0 ? FOCUS_PAUSED : FOCUS_NONE;
    f->elapsed_s = (int32_t)(el < 0 ? 0 : el > INT32_MAX ? INT32_MAX : el);
    return f->status != FOCUS_NONE;
}

static bool parse_snapshot(const P *p, int root, snap_t *s)
{
    int o = find(p, root, "snapshot"), v;
    if (o < 0 || p->t[o].type != JSMN_OBJECT) return false;
    memset(s, 0, sizeof *s);
    s->other_unread = s->today_done = s->today_total = -1;
    if (!get_time(p, o, "generated_at", &s->generated, S_REQ)) return false;
    if (!get_obj(p, o, "next_task", &v)) return false;
    if (v >= 0) { if (!parse_task(p, v, &s->task)) return false; s->has_task = true; }
    if (!get_obj(p, o, "next_event", &v)) return false;
    if (v >= 0) { if (!parse_event(p, v, &s->event)) return false; s->has_event = true; }
    if (!get_obj(p, o, "focus", &v)) return false;
    if (v >= 0 && !parse_focus(p, v, &s->focus)) return false;
    if (!get_count(p, o, "overdue_count", &s->overdue) || !get_count(p, o, "unread_count", &s->unread) ||
        !get_count(p, o, "other_unread_count", &s->other_unread) || !get_count(p, o, "today_done", &s->today_done) ||
        !get_count(p, o, "today_total", &s->today_total)) return false;
    v = find(p, o, "notices");
    if (v >= 0 && !is_null(p, v)) {
        if (p->t[v].type != JSMN_ARRAY) return false;
        int i = v + 1;
        for (int k = 0; k < p->t[v].size && k < 5; k++, i = skip(p, i)) {
            if (p->t[i].type != JSMN_OBJECT || !parse_notice(p, i, &s->notices[k])) return false;
            s->n_notices++;
        }
    }
    return true;
}

static const struct { const char *name; cmd_name_t cmd; } CMDS[] = {
    { "lost_mode", CMD_LOST_MODE }, { "play_sound", CMD_PLAY_SOUND }, { "ice_update", CMD_ICE_UPDATE },
    { "wifi_add", CMD_WIFI_ADD }, { "wifi_scan", CMD_WIFI_SCAN }, { "settings", CMD_SETTINGS },
    { "wifi_remove", CMD_WIFI_REMOVE }, { "wifi_order", CMD_WIFI_ORDER }, { "restart", CMD_RESTART }, { "unpair", CMD_UNPAIR },
};

static bool parse_lost(const P *p, int a, lost_cmd_t *l)
{
    char qr[10];
    l->qr = QR_TELEGRAM;
    if (!get_bool(p, a, "on", &l->on, S_REQ) || !get_str(p, a, "message", l->message, sizeof l->message, 0) ||
        !get_bool(p, a, "show_phone", &l->show_phone, 0) || !get_bool(p, a, "show_telegram", &l->show_telegram, 0) ||
        !get_bool(p, a, "show_email", &l->show_email, 0) || !get_str(p, a, "email", l->email, sizeof l->email, 0) ||
        !get_str(p, a, "qr", qr, sizeof qr, 0)) return false;
    if (qr[0] == '\0' || strcmp(qr, "telegram") == 0) l->qr = QR_TELEGRAM;
    else if (strcmp(qr, "phone") == 0) l->qr = QR_PHONE;
    else if (strcmp(qr, "none") == 0) l->qr = QR_NONE;
    else return false;
    return true;
}

static bool parse_ice(const P *p, int a, ice_cmd_t *c)
{
    c->show_contacts = c->show_med = true; /* v1 args have no such keys */
    int v = find(p, a, "contacts");
    if (v < 0 || p->t[v].type != JSMN_ARRAY || p->t[v].size > 2) return false;
    if (!get_str(p, a, "owner_name", c->owner_name, sizeof c->owner_name, 0) ||
        !get_str(p, a, "med_note", c->med_note, sizeof c->med_note, 0) || !get_bool(p, a, "show_name", &c->show_name, 0) ||
        !get_bool(p, a, "show_contacts", &c->show_contacts, 0) || !get_bool(p, a, "show_med", &c->show_med, 0)) return false;
    int i = v + 1;
    for (int k = 0; k < p->t[v].size; k++, i = skip(p, i)) {
        if (p->t[i].type != JSMN_OBJECT || !get_str(p, i, "name", c->name[k], sizeof c->name[k], S_REQ) ||
            !get_str(p, i, "relation", c->rel[k], sizeof c->rel[k], 0) || !get_str(p, i, "phone", c->phone[k], sizeof c->phone[k], S_REQ)) return false;
        c->n++;
    }
    return true;
}

static bool parse_order(const P *p, int a, uint8_t *n, char ssid[5][33])
{
    int v = find(p, a, "ssids");
    if (v < 0 || p->t[v].type != JSMN_ARRAY || p->t[v].size > 5) return false;
    for (int k = 0; k < p->t[v].size; k++) {
        int j = v + 1 + k; /* string elements are single tokens */
        int len = jstr(p, j, ssid[k], 33);
        if (len < 1 || len > 32) return false;
        (*n)++;
    }
    return true;
}

static bool parse_args(const P *p, int a, cmd_name_t name, proto_msg_t *out)
{
    __typeof__(out->u.cmd.a) *x = &out->u.cmd.a;
    int64_t b = 0;
    switch (name) {
    case CMD_LOST_MODE: return parse_lost(p, a, &x->lost);
    case CMD_ICE_UPDATE: return parse_ice(p, a, &x->ice);
    case CMD_WIFI_ADD: return get_str(p, a, "blob", x->blob, sizeof x->blob, S_REQ) && x->blob[0];
    case CMD_SETTINGS:
        if (!get_int(p, a, "brightness", &b, S_REQ) || b < 5 || b > 100) return false;
        x->settings.brightness = (uint8_t)b;
        return true;
    case CMD_WIFI_REMOVE: return get_str(p, a, "ssid", x->ssid, sizeof x->ssid, S_REQ) && x->ssid[0];
    case CMD_WIFI_ORDER: return parse_order(p, a, &x->order.n, x->order.ssid);
    default: return true; /* play_sound, wifi_scan, restart, unpair, unknown: args ignored */
    }
}

static bool parse_command(const P *p, proto_msg_t *out)
{
    char name[16];
    if (!get_str(p, 0, "id", out->id, sizeof out->id, S_REQ) || !get_str(p, 0, "name", name, sizeof name, S_REQ | S_TRUNC)) return false;
    out->u.cmd.name = CMD_UNKNOWN;
    for (size_t i = 0; i < sizeof CMDS / sizeof CMDS[0]; i++)
        if (strcmp(name, CMDS[i].name) == 0) out->u.cmd.name = CMDS[i].cmd;
    memcpy(out->u.cmd.raw_name, name, sizeof name);
    out->type = MSG_COMMAND; /* from here a failure still lets the caller ack BAD_ARGS */
    return parse_args(p, find(p, 0, "args"), out->u.cmd.name, out);
}

bool proto_parse(const char *json, size_t len, proto_msg_t *out)
{
    static jsmntok_t toks[MAX_TOKENS]; /* shortcut: not re-entrant, only the link task parses; make it a parameter if that changes */
    memset(out, 0, sizeof *out);
    out->type = MSG_UNKNOWN;
    if (len > MAX_FRAME) return false;
    jsmn_parser jp;
    jsmn_init(&jp);
    int n = jsmn_parse(&jp, json, len, toks, MAX_TOKENS);
    if (n < 1 || toks[0].type != JSMN_OBJECT) return false;
    P p = { json, toks };
    char type[16];
    if (!get_str(&p, 0, "type", type, sizeof type, S_REQ | S_TRUNC)) return false;
    msg_type_t t;
    if (strcmp(type, "ready") == 0) {
        if (!get_str(&p, 0, "device_id", out->id, sizeof out->id, S_REQ)) return false;
        t = MSG_READY;
    } else if (strcmp(type, "heartbeat_ack") == 0) t = MSG_HB_ACK;
    else if (strcmp(type, "snapshot") == 0) {
        if (!parse_snapshot(&p, 0, &out->u.snap)) return false;
        t = MSG_SNAPSHOT;
    } else if (strcmp(type, "action_result") == 0) {
        out->u.result.ok = false;
        if (!get_str(&p, 0, "id", out->id, sizeof out->id, S_REQ) || !get_bool(&p, 0, "ok", &out->u.result.ok, S_REQ) ||
            !get_str(&p, 0, "error_code", out->u.result.error, sizeof out->u.result.error, S_TRUNC)) return false;
        t = MSG_ACTION_RESULT;
    } else if (strcmp(type, "command") == 0) {
        return parse_command(&p, out);
    } else if (strcmp(type, "error") == 0) {
        if (!get_str(&p, 0, "code", out->u.error.code, sizeof out->u.error.code, S_TRUNC)) return false;
        t = MSG_ERROR;
    } else t = MSG_UNKNOWN;
    out->type = t;
    return true;
}

/* ----------------------------------------------------------------- building */

typedef struct { char *b; size_t cap, len; bool bad; } W;

static void w_init(W *w, char *b, size_t cap)
{
    w->b = b; w->cap = cap; w->len = 0; w->bad = cap == 0;
    if (cap) b[0] = '\0';
}

static void wr(W *w, const char *s)
{
    size_t n = strlen(s);
    if (w->bad || w->len + n + 1 > w->cap) { w->bad = true; return; }
    memcpy(w->b + w->len, s, n + 1);
    w->len += n;
}

static void wrf(W *w, const char *fmt, ...)
{
    if (w->bad) return;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(w->b + w->len, w->cap - w->len, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= w->cap - w->len) { w->bad = true; w->b[w->len] = '\0'; return; }
    w->len += (size_t)n;
}

static void wq(W *w, const char *s) /* "escaped"; NULL is "" */
{
    wr(w, "\"");
    if (w->bad) return;
    if (s && *s) {
        size_t n = json_escape(s, w->b + w->len, w->cap - w->len);
        if (n == 0) { w->bad = true; return; }
        w->len += n;
    }
    wr(w, "\"");
}

static size_t w_done(W *w)
{
    if (!w->bad) return w->len;
    if (w->cap) w->b[0] = '\0';
    return 0;
}

static const char *const ACT_STR[] = { "notification.read", "focus.start", "focus.pause", "focus.resume", "focus.stop", "task.complete" };

const char *act_kind_str(act_kind_t k) { return (unsigned)k < sizeof ACT_STR / sizeof ACT_STR[0] ? ACT_STR[k] : ""; }

size_t proto_hello(char *buf, size_t cap, const char *fw, const char *board, const char *phone, const char *telegram)
{
    W w; w_init(&w, buf, cap);
    wr(&w, "{\"type\":\"hello\",\"fw_version\":"); wq(&w, fw);
    wr(&w, ",\"board\":"); wq(&w, board);
    wr(&w, ",\"features\":[\"display\",\"speaker\",\"wifi_scan\"]");
    if (phone || telegram) {
        wr(&w, ",\"contacts\":{");
        if (phone) { wr(&w, "\"phone\":"); wq(&w, phone); }
        if (telegram) { wr(&w, phone ? ",\"telegram\":" : "\"telegram\":"); wq(&w, telegram); }
        wr(&w, "}");
    }
    wr(&w, "}");
    return w_done(&w);
}

size_t proto_heartbeat(char *buf, size_t cap)
{
    W w; w_init(&w, buf, cap);
    wr(&w, "{\"type\":\"heartbeat\"}");
    return w_done(&w);
}

size_t proto_metrics(char *buf, size_t cap, const proto_metrics_t *m)
{
    W w; w_init(&w, buf, cap);
    wrf(&w, "{\"type\":\"metrics\",\"heap_min_internal\":%lu,\"largest_block\":%lu,\"psram_free\":%lu,\"wifi_reconnects\":%lu,\"uptime_s\":%lu",
        (unsigned long)m->heap_min_internal, (unsigned long)m->largest_block, (unsigned long)m->psram_free,
        (unsigned long)m->wifi_reconnects, (unsigned long)m->uptime_s);
    if (m->battery_pct >= 0) wrf(&w, ",\"battery_pct\":%d,\"charging\":%s", m->battery_pct, m->charging ? "true" : "false");
    wrf(&w, ",\"heap_at_connect_min\":%lu}", (unsigned long)m->heap_at_connect_min);
    return w_done(&w);
}

size_t proto_action(char *buf, size_t cap, const char id[37], act_kind_t k, const char *target_id, const char *focus_mode)
{
    const char *tkey = k == ACT_NOTIFICATION_READ ? "notification_id" : k == ACT_TASK_COMPLETE ? "task_id" : NULL;
    if (!id || (unsigned)k >= sizeof ACT_STR / sizeof ACT_STR[0] || (tkey && !target_id)) return 0;
    W w; w_init(&w, buf, cap);
    wr(&w, "{\"type\":\"action\",\"id\":"); wq(&w, id);
    wr(&w, ",\"kind\":\""); wr(&w, ACT_STR[k]); wr(&w, "\",\"payload\":{");
    if (tkey) { wr(&w, "\""); wr(&w, tkey); wr(&w, "\":"); wq(&w, target_id); }
    else if (k == ACT_FOCUS_START && focus_mode) { wr(&w, "\"mode\":"); wq(&w, focus_mode); }
    wr(&w, "}}");
    return w_done(&w);
}

size_t proto_command_ack(char *buf, size_t cap, const char *id, bool ok, const char *error_code)
{
    W w; w_init(&w, buf, cap);
    wr(&w, "{\"type\":\"command_ack\",\"id\":"); wq(&w, id);
    wr(&w, ok ? ",\"ok\":true" : ",\"ok\":false");
    if (!ok && error_code) { wr(&w, ",\"error_code\":"); wq(&w, error_code); }
    wr(&w, "}");
    return w_done(&w);
}

size_t proto_wifi_scan_result(char *buf, size_t cap, const char *id, const wifi_seen_t *nets, int n)
{
    W w; w_init(&w, buf, cap);
    wr(&w, "{\"type\":\"wifi_scan_result\",\"id\":"); wq(&w, id);
    wr(&w, ",\"networks\":[");
    if (w.bad || cap < 2) return w_done(&w);
    w.cap -= 2; /* keep room for "]}" so a cut-off list is still valid JSON */
    bool first = true;
    for (int i = 0; i < n; i++) {
        if (!nets[i].ssid[0]) continue; /* hidden networks cannot be joined from the app */
        size_t mark = w.len;
        if (!first) wr(&w, ",");
        wr(&w, "{\"ssid\":"); wq(&w, nets[i].ssid);
        wrf(&w, ",\"rssi\":%d,\"secure\":%s}", nets[i].rssi, nets[i].secure ? "true" : "false");
        if (w.bad) { w.bad = false; w.len = mark; w.b[mark] = '\0'; break; }
        first = false;
    }
    w.cap += 2;
    wr(&w, "]}");
    return w_done(&w);
}

size_t proto_wifi_state(char *buf, size_t cap, const wifi_list_t *saved, const char *current)
{
    W w; w_init(&w, buf, cap);
    wr(&w, "{\"type\":\"wifi_state\",\"saved\":[");
    for (int i = 0; i < saved->n && i < WIFI_MAX; i++) { if (i) wr(&w, ","); wq(&w, saved->net[i].ssid); }
    wr(&w, "],\"current\":");
    if (current) wq(&w, current); else wr(&w, "null");
    wr(&w, "}");
    return w_done(&w);
}
