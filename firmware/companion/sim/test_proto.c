#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define JSMN_STATIC
#include "jsmn.h"
#include "check.h"
#include "codec_util.h"
#include "proto.h"

static proto_msg_t g_m; /* ~2.3 KB: static, like the firmware does */

static int64_t iso(const char *s)
{
    int64_t v = -1;
    CHECK(iso8601_to_epoch(s, strlen(s), &v));
    return v;
}

static size_t load(const char *name, char *buf, size_t cap)
{
    char path[512];
    snprintf(path, sizeof path, "%s/%s.json", PROTO_CORPUS_DIR, name);
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", path); g_failed++; buf[0] = '\0'; return 0; }
    size_t n = fread(buf, 1, cap - 1, f);
    fclose(f);
    buf[n] = '\0';
    return n;
}

/* parse corpus file `name` into g_m; returns proto_parse's result */
static bool parse_file(const char *name)
{
    static char buf[4200];
    size_t n = load(name, buf, sizeof buf);
    memset(&g_m, 0xA5, sizeof g_m); /* poison: a field the parser forgets to set shows up */
    return proto_parse(buf, n, &g_m);
}

static void test_parses_every_contract_example(void)
{
    CHECK(parse_file("ready"));
    CHECK_EQ(g_m.type, MSG_READY);
    CHECK(strcmp(g_m.id, "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d") == 0);

    CHECK(parse_file("heartbeat_ack"));
    CHECK_EQ(g_m.type, MSG_HB_ACK);

    CHECK(parse_file("snapshot_v1"));
    CHECK_EQ(g_m.type, MSG_SNAPSHOT);
    const snap_t *s = &g_m.u.snap;
    CHECK_EQ(s->generated, iso("2026-11-13T09:30:00Z"));
    CHECK(s->has_task);
    CHECK(strcmp(s->task.id, "t-101") == 0 && strcmp(s->task.title, "Submit report") == 0);
    CHECK_EQ(s->task.due, iso("2026-11-13T12:00:00Z"));
    CHECK(s->has_event && !s->event.all_day && s->event.has_end);
    CHECK(strcmp(s->event.id, "e-22") == 0 && strcmp(s->event.title, "Standup") == 0);
    CHECK_EQ(s->event.starts, iso("2026-11-13T10:00:00Z"));
    CHECK_EQ(s->event.ends, iso("2026-11-13T10:15:00Z"));
    CHECK_EQ(s->overdue, 1);
    CHECK_EQ(s->unread, 5);
    CHECK_EQ(s->n_notices, 1);
    CHECK(strcmp(s->notices[0].id, "n-9") == 0 && strcmp(s->notices[0].kind, "task.reminder") == 0);
    CHECK(strcmp(s->notices[0].title, "Submit report soon") == 0);
    CHECK_EQ(s->notices[0].created, iso("2026-11-13T09:00:00Z"));
    CHECK_EQ(s->focus.status, FOCUS_ACTIVE);
    CHECK(strcmp(s->focus.id, "f-3") == 0 && strcmp(s->focus.mode, "pomodoro") == 0);
    CHECK_EQ(s->focus.started, iso("2026-11-13T09:10:00Z"));
    CHECK_EQ(s->focus.elapsed_s, 1200);
    CHECK_EQ(s->today_total, -1);
    CHECK_EQ(s->today_done, -1);
    CHECK_EQ(s->other_unread, -1);
    CHECK(s->n_tasks == 0 && s->n_events == 0); /* an older server: no lists */

    CHECK(parse_file("action_result_ok"));
    CHECK_EQ(g_m.type, MSG_ACTION_RESULT);
    CHECK(strcmp(g_m.id, "5f0c2a7e-3b1d-4c8e-9a6f-2d7b1e4c9a10") == 0);
    CHECK(g_m.u.result.ok && g_m.u.result.error[0] == '\0');

    CHECK(parse_file("action_result_err"));
    CHECK(!g_m.u.result.ok && strcmp(g_m.u.result.error, "NO_ACTIVE_FOCUS") == 0);

    CHECK(parse_file("error"));
    CHECK_EQ(g_m.type, MSG_ERROR);
    CHECK(strcmp(g_m.u.error.code, "VALIDATION_ERROR") == 0);

    CHECK(parse_file("cmd_lost_mode"));
    CHECK_EQ(g_m.type, MSG_COMMAND);
    CHECK_EQ(g_m.u.cmd.name, CMD_LOST_MODE);
    CHECK(strcmp(g_m.id, "c1d2e3f4-0a1b-4c2d-8e3f-4a5b6c7d8e9f") == 0);
    const lost_cmd_t *l = &g_m.u.cmd.a.lost;
    CHECK(l->on && l->show_phone && !l->show_telegram && !l->show_email);
    CHECK(strcmp(l->message, "If found, call the owner") == 0 && l->email[0] == '\0');
    CHECK_EQ(l->qr, QR_TELEGRAM); /* v1: no qr key */
    CHECK_EQ(l->rev, 3);

    CHECK(parse_file("cmd_wifi_add"));
    CHECK_EQ(g_m.u.cmd.name, CMD_WIFI_ADD);
    CHECK(strcmp(g_m.u.cmd.a.blob, "q2V5ZGF0YS1lbmNyeXB0ZWQ") == 0);

    CHECK(parse_file("cmd_play_sound"));
    CHECK_EQ(g_m.u.cmd.name, CMD_PLAY_SOUND);
    CHECK(parse_file("cmd_wifi_scan"));
    CHECK_EQ(g_m.u.cmd.name, CMD_WIFI_SCAN);
    CHECK(strcmp(g_m.id, "d4e5f6a7-1b2c-4d3e-9f8a-7b6c5d4e3f2a") == 0);

    CHECK(parse_file("cmd_ice_v1"));
    CHECK_EQ(g_m.u.cmd.name, CMD_ICE_UPDATE);
    const ice_cmd_t *ic = &g_m.u.cmd.a.ice;
    CHECK_EQ(ic->n, 2);
    CHECK(strcmp(ic->name[0], "Mom") == 0 && strcmp(ic->phone[1], "+7 701 000 00 02") == 0);
    CHECK(ic->rel[0][0] == '\0' && ic->rel[1][0] == '\0' && ic->owner_name[0] == '\0');
    CHECK(strcmp(ic->med_note, "Allergy: penicillin") == 0);
    CHECK(ic->show_name && ic->show_contacts && ic->show_med); /* v1 defaults */
    CHECK_EQ(ic->rev, 4);
}

static void test_parses_v11_examples(void)
{
    CHECK(parse_file("snapshot_v11"));
    const snap_t *s = &g_m.u.snap;
    CHECK_EQ(s->generated, iso("2026-11-13T09:30:00Z")); /* fractional seconds and +00:00 accepted */
    CHECK(!s->has_task && s->has_event);
    CHECK(s->event.all_day && !s->event.has_end);
    CHECK_EQ(s->focus.status, FOCUS_NONE);
    CHECK_EQ(s->today_done, 3);
    CHECK_EQ(s->today_total, 7);
    CHECK_EQ(s->other_unread, 4);
    CHECK(s->n_tasks == 0 && s->n_events == 0);

    CHECK(parse_file("cmd_lost_mode_v11"));
    const lost_cmd_t *l = &g_m.u.cmd.a.lost;
    CHECK(l->on && !l->show_phone && !l->show_telegram && l->show_email);
    CHECK(strcmp(l->email, "owner@example.com") == 0);
    CHECK_EQ(l->qr, QR_PHONE);
    CHECK_EQ(l->rev, 7);

    CHECK(parse_file("cmd_ice_v11"));
    const ice_cmd_t *ic = &g_m.u.cmd.a.ice;
    CHECK(strcmp(ic->owner_name, "Aigerim") == 0);
    CHECK_EQ(ic->n, 1);
    CHECK(strcmp(ic->rel[0], "Mother") == 0);
    CHECK(ic->show_name && !ic->show_contacts && ic->show_med);
    CHECK_EQ(ic->rev, 8);

    CHECK(parse_file("cmd_settings"));
    CHECK_EQ(g_m.u.cmd.name, CMD_SETTINGS);
    CHECK_EQ(g_m.u.cmd.a.settings.brightness, 40);
    CHECK_EQ(g_m.u.cmd.a.settings.rev, 2);
    const char *norev = "{\"type\":\"command\",\"id\":\"c\",\"name\":\"settings\",\"args\":{\"brightness\":60}}";
    CHECK(proto_parse(norev, strlen(norev), &g_m));       /* v1.1 server without a rev: unversioned */
    CHECK_EQ(g_m.u.cmd.a.settings.rev, 0);
    const char *badrev = "{\"type\":\"command\",\"id\":\"c\",\"name\":\"settings\",\"args\":{\"brightness\":60,\"rev\":-1}}";
    CHECK(!proto_parse(badrev, strlen(badrev), &g_m));
    CHECK_EQ(g_m.type, MSG_COMMAND);

    CHECK(parse_file("cmd_wifi_remove"));
    CHECK_EQ(g_m.u.cmd.name, CMD_WIFI_REMOVE);
    CHECK(strcmp(g_m.u.cmd.a.ssid, "Office") == 0);

    CHECK(parse_file("cmd_wifi_order"));
    CHECK_EQ(g_m.u.cmd.name, CMD_WIFI_ORDER);
    CHECK_EQ(g_m.u.cmd.a.order.n, 3);
    CHECK(strcmp(g_m.u.cmd.a.order.ssid[1], "Office") == 0);
    CHECK(strcmp(g_m.u.cmd.a.order.ssid[2], "Caf\xC3\xA9") == 0); /* \u00e9 decoded */

    CHECK(parse_file("cmd_restart"));
    CHECK_EQ(g_m.u.cmd.name, CMD_RESTART);
    CHECK(parse_file("cmd_unpair"));
    CHECK_EQ(g_m.u.cmd.name, CMD_UNPAIR);
}

static bool parse_str(const char *json)
{
    memset(&g_m, 0xA5, sizeof g_m);
    return proto_parse(json, strlen(json), &g_m);
}

#define SNAP_HEAD "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\","
#define T(id, due) "{\"id\":\"" id "\",\"title\":\"T " id "\",\"due_at\":\"" due "\"}"

static void test_snapshot_lists(void)
{
    CHECK(parse_file("snapshot_v12"));
    const snap_t *s = &g_m.u.snap;
    CHECK(s->has_task && s->has_event && strcmp(s->task.id, "t-101") == 0); /* the v1 fields are still read */
    CHECK_EQ(s->n_tasks, 3);
    CHECK(strcmp(s->tasks[0].id, "t-101") == 0 && strcmp(s->tasks[1].title, "Reply to Dana") == 0);
    CHECK_EQ(s->tasks[2].due, iso("2026-11-12T08:00:00Z"));
    CHECK_EQ(s->n_events, 3);
    CHECK(strcmp(s->events[0].title, "Standup") == 0 && s->events[0].has_end && !s->events[0].all_day);
    CHECK_EQ(s->events[0].ends, iso("2026-11-13T10:15:00Z"));
    CHECK_EQ(s->events[1].starts, iso("2026-11-14T09:30:00Z"));
    CHECK(s->events[2].all_day && !s->events[2].has_end);
    CHECK_EQ(s->today_done, 2);

    /* null, empty and wrongly typed lists are no list; the rest of the snapshot is kept */
    CHECK(parse_str(SNAP_HEAD "\"next_task\":null,\"tasks_today\":null,\"events_upcoming\":[]}}"));
    CHECK(g_m.u.snap.n_tasks == 0 && g_m.u.snap.n_events == 0);
    CHECK(parse_str(SNAP_HEAD "\"unread_count\":4,\"tasks_today\":{\"a\":1},\"events_upcoming\":\"x\"}}"));
    CHECK(g_m.u.snap.n_tasks == 0 && g_m.u.snap.n_events == 0 && g_m.u.snap.unread == 4);

    /* a bad entry is skipped (not an object, no id, bad time, title of the wrong type); good ones around it stay */
    CHECK(parse_str(SNAP_HEAD "\"unread_count\":4,\"tasks_today\":[" T("a", "2026-11-13T10:00:00Z") ",7,{\"title\":\"no id\",\"due_at\":\"2026-11-13T10:00:00Z\"},"
                    T("b", "yesterday") ",{\"id\":\"c\",\"title\":5,\"due_at\":\"2026-11-13T10:00:00Z\"}," T("d", "2026-11-13T11:00:00Z") "],"
                    "\"events_upcoming\":[{\"id\":\"e\",\"title\":\"x\",\"starts_at\":\"2026-11-13T10:00:00Z\",\"all_day\":\"yes\"},[1,2],"
                    "{\"id\":\"f\",\"title\":\"ok\",\"starts_at\":\"2026-11-13T12:00:00Z\",\"ends_at\":\"2026-11-13T13:00:00Z\",\"all_day\":false}]}}"));
    s = &g_m.u.snap;
    CHECK_EQ(s->unread, 4);
    CHECK_EQ(s->n_tasks, 2);
    CHECK(strcmp(s->tasks[0].id, "a") == 0 && strcmp(s->tasks[1].id, "d") == 0);
    CHECK_EQ(s->n_events, 1);
    CHECK(strcmp(s->events[0].id, "f") == 0 && s->events[0].has_end);
    CHECK(s->tasks[2].id[0] == '\0' && s->events[1].id[0] == '\0'); /* unused entries are zero, not poison */

    /* more than the arrays hold: the first ones count */
    CHECK(parse_str(SNAP_HEAD "\"tasks_today\":[" T("1", "2026-11-13T10:00:00Z") "," T("2", "2026-11-13T10:00:00Z") "," T("3", "2026-11-13T10:00:00Z") ","
                    T("4", "2026-11-13T10:00:00Z") "," T("5", "2026-11-13T10:00:00Z") "," T("6", "2026-11-13T10:00:00Z") "," T("7", "2026-11-13T10:00:00Z") "]}}"));
    CHECK_EQ(g_m.u.snap.n_tasks, SNAP_MAX_TASKS);
    CHECK(strcmp(g_m.u.snap.tasks[4].id, "5") == 0);

    /* a title of 80 Cyrillic letters is cut on a character boundary, never rejected */
    char json[1200], title[200];
    for (int i = 0; i < 80; i++) memcpy(title + 2 * i, "\xD0\xAF", 2);
    title[160] = '\0';
    snprintf(json, sizeof json, SNAP_HEAD "\"tasks_today\":[{\"id\":\"a\",\"title\":\"%s\",\"due_at\":\"2026-11-13T10:00:00Z\"}]}}", title);
    CHECK(parse_str(json));
    CHECK_EQ(g_m.u.snap.n_tasks, 1);
    CHECK_EQ(strlen(g_m.u.snap.tasks[0].title) % 2, 0);
}

/* The most tokens a snapshot can use (every field of every object, 5 notices, a focus, both lists full) must fit the parser's token
 * table, or the whole frame would be rejected. Titles are short: the byte cap is the server's job (docs/companion-protocol.md). */
static void test_fullest_snapshot_fits_the_token_table(void)
{
    char json[4096];
    int n = snprintf(json, sizeof json, "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\","
        "\"next_task\":" T("a", "2026-11-13T10:00:00Z") ",\"overdue_count\":1,"
        "\"next_event\":{\"id\":\"e\",\"title\":\"E\",\"starts_at\":\"2026-11-13T10:00:00Z\",\"ends_at\":\"2026-11-13T11:00:00Z\",\"all_day\":false},"
        "\"unread_count\":5,\"notices\":[");
    for (int i = 0; i < 5; i++)
        n += snprintf(json + n, sizeof json - (size_t)n, "%s{\"id\":\"n%d\",\"kind\":\"task.reminder\",\"title\":\"N\",\"created_at\":\"2026-11-13T09:00:00Z\"}", i ? "," : "", i);
    n += snprintf(json + n, sizeof json - (size_t)n, "],\"focus\":{\"id\":\"f\",\"status\":\"active\",\"mode\":\"m\",\"started_at\":\"2026-11-13T09:10:00Z\",\"elapsed_seconds\":1},"
        "\"today_done\":1,\"today_total\":2,\"other_unread_count\":1,\"tasks_today\":[");
    for (int i = 0; i < 5; i++)
        n += snprintf(json + n, sizeof json - (size_t)n, "%s{\"id\":\"t%d\",\"title\":\"T\",\"due_at\":\"2026-11-13T10:00:00Z\"}", i ? "," : "", i);
    n += snprintf(json + n, sizeof json - (size_t)n, "],\"events_upcoming\":[");
    for (int i = 0; i < 4; i++)
        n += snprintf(json + n, sizeof json - (size_t)n, "%s{\"id\":\"e%d\",\"title\":\"E\",\"starts_at\":\"2026-11-13T10:00:00Z\",\"ends_at\":\"2026-11-13T11:00:00Z\",\"all_day\":false}", i ? "," : "", i);
    snprintf(json + n, sizeof json - (size_t)n, "]}}");
    CHECK(parse_str(json));
    CHECK(g_m.u.snap.n_notices == 5 && g_m.u.snap.n_tasks == 5 && g_m.u.snap.n_events == 4 && g_m.u.snap.focus.status == FOCUS_ACTIVE);
}

static void test_command_unknown_name_is_not_rejected(void)
{
    CHECK(parse_file("cmd_unknown"));
    CHECK_EQ(g_m.type, MSG_COMMAND);
    CHECK_EQ(g_m.u.cmd.name, CMD_UNKNOWN);
    CHECK(strcmp(g_m.id, "d1d1d1d1-0a1b-4c2d-8e3f-4a5b6c7d8e9f") == 0);
    CHECK(strcmp(g_m.u.cmd.raw_name, "self_destruct_n") == 0); /* cut to 15 bytes */
}

static void test_snapshot_nulls_and_missing_optional(void)
{
    const char *j = "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\","
                    "\"next_task\":null,\"overdue_count\":0,\"next_event\":null,\"unread_count\":0,\"focus\":null}}";
    CHECK(proto_parse(j, strlen(j), &g_m));
    CHECK(!g_m.u.snap.has_task && !g_m.u.snap.has_event);
    CHECK_EQ(g_m.u.snap.n_notices, 0);
    CHECK_EQ(g_m.u.snap.focus.status, FOCUS_NONE);
    const char *j2 = "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\"}}";
    CHECK(proto_parse(j2, strlen(j2), &g_m));
    CHECK(!g_m.u.snap.has_task && g_m.u.snap.overdue == 0 && g_m.u.snap.unread == 0);
}

static void test_more_than_5_notices_keeps_first_5(void)
{
    char j[1500];
    int o = snprintf(j, sizeof j, "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\",\"notices\":[");
    for (int i = 0; i < 8; i++)
        o += snprintf(j + o, sizeof j - (size_t)o, "%s{\"id\":\"n-%d\",\"kind\":\"task.due\",\"title\":\"T%d\",\"created_at\":\"2026-11-13T09:00:00Z\"}",
                      i ? "," : "", i, i);
    snprintf(j + o, sizeof j - (size_t)o, "]}}");
    CHECK(proto_parse(j, strlen(j), &g_m));
    CHECK_EQ(g_m.u.snap.n_notices, 5);
    CHECK(strcmp(g_m.u.snap.notices[0].id, "n-0") == 0 && strcmp(g_m.u.snap.notices[4].id, "n-4") == 0);
}

static int valid_utf8(const char *s)
{
    for (const unsigned char *p = (const unsigned char *)s; *p;) {
        int k = *p < 0x80 ? 1 : (*p >> 5) == 6 ? 2 : (*p >> 4) == 14 ? 3 : (*p >> 3) == 30 ? 4 : 0;
        if (!k) return 0;
        for (int i = 1; i < k; i++) if ((p[i] & 0xC0) != 0x80) return 0;
        p += k;
    }
    return 1;
}

static void test_titles_cut_on_utf8_boundary(void)
{
    static char j[600];
    int o = snprintf(j, sizeof j, "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\","
                     "\"next_task\":{\"id\":\"t\",\"due_at\":\"2026-11-13T12:00:00Z\",\"title\":\"");
    for (int i = 0; i < 100; i++) o += snprintf(j + o, sizeof j - (size_t)o, "\xD0\x96");
    snprintf(j + o, sizeof j - (size_t)o, "\"}}}");
    CHECK(proto_parse(j, strlen(j), &g_m));
    CHECK_EQ(strlen(g_m.u.snap.task.title), 64);
    CHECK(valid_utf8(g_m.u.snap.task.title));

    /* the same through \u escapes, and a 4-byte emoji that straddles the cut (63 ASCII + emoji) */
    o = snprintf(j, sizeof j, "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\","
                 "\"next_task\":{\"id\":\"t\",\"due_at\":\"2026-11-13T12:00:00Z\",\"title\":\"");
    for (int i = 0; i < 63; i++) o += snprintf(j + o, sizeof j - (size_t)o, "a");
    snprintf(j + o, sizeof j - (size_t)o, "\\ud83d\\ude00\"}}}");
    CHECK(proto_parse(j, strlen(j), &g_m));
    CHECK_EQ(strlen(g_m.u.snap.task.title), 63);
}

static void test_string_escapes_are_decoded(void)
{
    const char *j = "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\","
                    "\"next_task\":{\"id\":\"t\",\"due_at\":\"2026-11-13T12:00:00Z\","
                    "\"title\":\"\\u0416 \\ud83d\\ude00 \\\"q\\\" \\\\ \\n\\/ \\ud800x\"}}}";
    CHECK(proto_parse(j, strlen(j), &g_m));
    CHECK(strcmp(g_m.u.snap.task.title, "\xD0\x96 \xF0\x9F\x98\x80 \"q\" \\ \n/ \xEF\xBF\xBDx") == 0);
}

static void test_rejects(void)
{
    CHECK(!proto_parse("not json at all", 15, &g_m));
    CHECK(!proto_parse("", 0, &g_m));
    CHECK(!proto_parse("{\"type\":", 8, &g_m));
    CHECK(!proto_parse("[\"type\"]", 8, &g_m));
    CHECK(!proto_parse("{\"hello\":1}", 11, &g_m));            /* no type */
    CHECK(!proto_parse("{\"type\":7}", 10, &g_m));             /* type not a string */
    static char big[4200];
    memset(big, ' ', sizeof big);
    const char *ok = "{\"type\":\"heartbeat_ack\"}";
    memcpy(big, ok, strlen(ok));
    CHECK(proto_parse(big, 4096, &g_m));                       /* exactly 4 KB is fine */
    CHECK(!proto_parse(big, 4097, &g_m));
    CHECK(!proto_parse("{\"type\":\"action_result\",\"ok\":true}", 33, &g_m));        /* no id */
    CHECK(!proto_parse("{\"type\":\"action_result\",\"id\":\"x\"}", 32, &g_m));        /* no ok */
    CHECK(!proto_parse("{\"type\":\"ready\"}", 16, &g_m));                              /* no device_id */
    CHECK(!proto_parse("{\"type\":\"snapshot\"}", 19, &g_m));                           /* no snapshot */
    CHECK(!proto_parse("{\"type\":\"command\",\"name\":\"restart\"}", 33, &g_m));       /* no id */
    const char *bad_date = "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"yesterday\"}}";
    CHECK(!proto_parse(bad_date, strlen(bad_date), &g_m));
    const char *bad_focus = "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\","
                            "\"focus\":{\"id\":\"f\",\"status\":\"weird\",\"mode\":\"m\",\"started_at\":\"2026-11-13T09:30:00Z\",\"elapsed_seconds\":1}}}";
    CHECK(!proto_parse(bad_focus, strlen(bad_focus), &g_m));
    const char *unk = "{\"type\":\"from_the_future\",\"x\":1}";
    CHECK(proto_parse(unk, strlen(unk), &g_m));
    CHECK_EQ(g_m.type, MSG_UNKNOWN);
    int o;
    /* data after the root object */
    const char *trail[] = { "{\"type\":\"ready\",\"device_id\":\"d\"} \"x\"", "{\"type\":\"ready\",\"device_id\":\"d\"} 5",
                            "{\"type\":\"ready\",\"device_id\":\"d\"} {\"a\":1}", "{\"type\":\"ready\",\"device_id\":\"d\"}{\"type\":\"ready\"}" };
    for (size_t i = 0; i < sizeof trail / sizeof trail[0]; i++) CHECK(!proto_parse(trail[i], strlen(trail[i]), &g_m));
    CHECK(proto_parse("{\"type\":\"ready\",\"device_id\":\"d\"}  \n", 38, &g_m)); /* trailing whitespace is fine */
    /* bare strings inside an object (not key/value pairs) must be rejected, never walked off the token array */
    static char hostile[2200];
    o = snprintf(hostile, sizeof hostile, "{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\"");
    for (int i = 0; i < 236; i++) o += snprintf(hostile + o, sizeof hostile - (size_t)o, ",\"a\"");
    snprintf(hostile + o, sizeof hostile - (size_t)o, "}}");
    CHECK(!proto_parse(hostile, strlen(hostile), &g_m));
    o = snprintf(hostile, sizeof hostile, "{\"type\":\"ready\",\"device_id\":\"d\"");
    for (int i = 0; i < 200; i++) o += snprintf(hostile + o, sizeof hostile - (size_t)o, ",\"a\"");
    snprintf(hostile + o, sizeof hostile - (size_t)o, "}");
    CHECK(!proto_parse(hostile, strlen(hostile), &g_m));
    /* more tokens than the static array holds must fail, not overflow */
    static char many[4096];
    o = snprintf(many, sizeof many, "{\"type\":\"ready\",\"device_id\":\"d\",\"x\":[");
    for (int i = 0; i < 700; i++) o += snprintf(many + o, sizeof many - (size_t)o, "%s1", i ? "," : "");
    snprintf(many + o, sizeof many - (size_t)o, "]}");
    CHECK(!proto_parse(many, strlen(many), &g_m));
}

static void test_long_free_text_is_cut_not_rejected(void)
{
    static char j[1200];
    char zh40[81] = "", zh60[121] = "";
    for (int i = 0; i < 40; i++) strcat(zh40, "\xD0\x96");
    for (int i = 0; i < 60; i++) strcat(zh60, "\xD0\x96");
    snprintf(j, sizeof j, "{\"type\":\"command\",\"id\":\"c\",\"name\":\"lost_mode\",\"args\":{\"on\":true,\"message\":\"%s\",\"email\":\"%s\"}}", zh40, zh60);
    CHECK(proto_parse(j, strlen(j), &g_m));
    CHECK_EQ(strlen(g_m.u.cmd.a.lost.message), 64);
    CHECK_EQ(strlen(g_m.u.cmd.a.lost.email), 48);
    CHECK(valid_utf8(g_m.u.cmd.a.lost.message) && valid_utf8(g_m.u.cmd.a.lost.email));
    snprintf(j, sizeof j, "{\"type\":\"command\",\"id\":\"c\",\"name\":\"ice_update\",\"args\":{\"owner_name\":\"%s\",\"med_note\":\"%s\","
             "\"contacts\":[{\"name\":\"%s\",\"relation\":\"%s\",\"phone\":\"+7\"}]}}", zh40, zh60, zh40, zh40);
    CHECK(proto_parse(j, strlen(j), &g_m));
    const ice_cmd_t *ic = &g_m.u.cmd.a.ice;
    CHECK_EQ(strlen(ic->owner_name), 32);
    CHECK_EQ(strlen(ic->med_note), 96);
    CHECK_EQ(strlen(ic->name[0]), 32);
    CHECK_EQ(strlen(ic->rel[0]), 16);
    CHECK(valid_utf8(ic->owner_name) && valid_utf8(ic->med_note) && valid_utf8(ic->name[0]) && valid_utf8(ic->rel[0]));
    /* ids, ssid, phone stay strict */
    snprintf(j, sizeof j, "{\"type\":\"command\",\"id\":\"c\",\"name\":\"ice_update\",\"args\":{\"contacts\":[{\"name\":\"a\",\"phone\":\"123456789012345678901234\"}]}}");
    CHECK(!proto_parse(j, strlen(j), &g_m));
}

static void test_command_rev(void)
{
    const char *none = "{\"type\":\"command\",\"id\":\"c\",\"name\":\"lost_mode\",\"args\":{\"on\":false}}";
    CHECK(proto_parse(none, strlen(none), &g_m));
    CHECK_EQ(g_m.u.cmd.a.lost.rev, 0);                  /* missing rev = unversioned */
    const char *big = "{\"type\":\"command\",\"id\":\"c\",\"name\":\"ice_update\",\"args\":{\"contacts\":[],\"rev\":4294967295}}";
    CHECK(proto_parse(big, strlen(big), &g_m));
    CHECK_EQ(g_m.u.cmd.a.ice.rev, 4294967295u);
    const char *bad[] = {
        "{\"type\":\"command\",\"id\":\"c\",\"name\":\"lost_mode\",\"args\":{\"on\":true,\"rev\":-1}}",
        "{\"type\":\"command\",\"id\":\"c\",\"name\":\"lost_mode\",\"args\":{\"on\":true,\"rev\":4294967296}}",
        "{\"type\":\"command\",\"id\":\"c\",\"name\":\"ice_update\",\"args\":{\"contacts\":[],\"rev\":\"3\"}}" };
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        CHECK(!proto_parse(bad[i], strlen(bad[i]), &g_m));  /* out of range or not a number: BAD_ARGS, never a clamped rev */
        CHECK_EQ(g_m.type, MSG_COMMAND);
    }
}

static void test_command_bad_args_still_reports_id(void)
{
    const char *j = "{\"type\":\"command\",\"id\":\"cid\",\"name\":\"settings\",\"args\":{\"brightness\":200}}";
    CHECK(!proto_parse(j, strlen(j), &g_m));
    CHECK_EQ(g_m.type, MSG_COMMAND);
    CHECK(strcmp(g_m.id, "cid") == 0);
    CHECK_EQ(g_m.u.cmd.name, CMD_SETTINGS);
    const char *j2 = "{\"type\":\"command\",\"id\":\"c2\",\"name\":\"wifi_remove\",\"args\":{\"ssid\":\"123456789012345678901234567890123\"}}";
    CHECK(!proto_parse(j2, strlen(j2), &g_m));
    CHECK_EQ(g_m.type, MSG_COMMAND);
    const char *j3 = "{\"type\":\"command\",\"id\":\"c3\",\"name\":\"lost_mode\",\"args\":{\"message\":\"x\"}}";
    CHECK(!proto_parse(j3, strlen(j3), &g_m));          /* "on" is required */
    CHECK(strcmp(g_m.id, "c3") == 0);
    const char *j4 = "{\"type\":\"command\",\"id\":\"c4\",\"name\":\"wifi_add\",\"args\":{}}";
    CHECK(!proto_parse(j4, strlen(j4), &g_m));
}

/* ---- builders ---- */

typedef struct { const char *js; jsmntok_t t[128]; int n; } J;

static void jload(J *j, const char *js)
{
    jsmn_parser p;
    jsmn_init(&p);
    j->js = js;
    j->n = jsmn_parse(&p, js, strlen(js), j->t, 128);
    CHECK(j->n > 0);
}

static int jskip(const J *j, int i)
{
    int pending = 1;
    while (pending > 0) pending += j->t[i++].size - 1;
    return i;
}

/* token index of the value for key under object token `obj`, or -1 */
static int jkey(const J *j, int obj, const char *key)
{
    int i = obj + 1;
    for (int c = 0; c < j->t[obj].size; c++) {
        const jsmntok_t *k = &j->t[i];
        if ((size_t)(k->end - k->start) == strlen(key) && strncmp(j->js + k->start, key, strlen(key)) == 0) return i + 1;
        i = jskip(j, i + 1);
    }
    return -1;
}

static bool jis(const J *j, int obj, const char *key, const char *raw) /* value text (strings: undecoded, no quotes) */
{
    int v = jkey(j, obj, key);
    return v >= 0 && (size_t)(j->t[v].end - j->t[v].start) == strlen(raw) && strncmp(j->js + j->t[v].start, raw, strlen(raw)) == 0;
}

static void test_built_messages_parse_as_json(void)
{
    char b[1024];
    J j;

    CHECK(proto_heartbeat(b, sizeof b) > 0);
    CHECK(strcmp(b, "{\"type\":\"heartbeat\"}") == 0);

    size_t n = proto_hello(b, sizeof b, "0.4.1", "waveshare-amoled-1.75c", "+7 700 111 22 33", "@owner");
    CHECK(n > 0 && n == strlen(b));
    jload(&j, b);
    CHECK(jis(&j, 0, "type", "hello") && jis(&j, 0, "fw_version", "0.4.1") && jis(&j, 0, "board", "waveshare-amoled-1.75c"));
    int f = jkey(&j, 0, "features");
    CHECK(f > 0 && j.t[f].type == JSMN_ARRAY && j.t[f].size == 3);
    CHECK(strstr(b, "\"features\":[\"display\",\"speaker\",\"wifi_scan\"]") != NULL);
    int c = jkey(&j, 0, "contacts");
    CHECK(c > 0 && jis(&j, c, "phone", "+7 700 111 22 33") && jis(&j, c, "telegram", "@owner"));
    n = proto_hello(b, sizeof b, "0.4.1", "waveshare-amoled-1.75c", NULL, NULL);
    CHECK(n > 0 && strstr(b, "contacts") == NULL);
    CHECK_EQ(proto_hello(b, 20, "0.4.1", "waveshare-amoled-1.75c", NULL, NULL), 0); /* does not fit */

    proto_metrics_t m = { 84312, 61440, 7864320, 2, 3600, 87, true, 70000 };
    CHECK(proto_metrics(b, sizeof b, &m) > 0);
    jload(&j, b);
    CHECK(jis(&j, 0, "type", "metrics") && jis(&j, 0, "heap_min_internal", "84312") && jis(&j, 0, "largest_block", "61440"));
    CHECK(jis(&j, 0, "psram_free", "7864320") && jis(&j, 0, "wifi_reconnects", "2") && jis(&j, 0, "uptime_s", "3600"));
    CHECK(jis(&j, 0, "battery_pct", "87") && jis(&j, 0, "charging", "true") && jis(&j, 0, "heap_at_connect_min", "70000"));
    m.battery_pct = -1;
    CHECK(proto_metrics(b, sizeof b, &m) > 0);
    CHECK(strstr(b, "battery_pct") == NULL && strstr(b, "charging") == NULL);

    const char *id = "5f0c2a7e-3b1d-4c8e-9a6f-2d7b1e4c9a10";
    CHECK(proto_action(b, sizeof b, id, ACT_TASK_COMPLETE, "t-1", NULL) > 0);
    CHECK(strcmp(b, "{\"type\":\"action\",\"id\":\"5f0c2a7e-3b1d-4c8e-9a6f-2d7b1e4c9a10\",\"kind\":\"task.complete\",\"payload\":{\"task_id\":\"t-1\"}}") == 0);
    CHECK(proto_action(b, sizeof b, id, ACT_NOTIFICATION_READ, "n-9", NULL) > 0);
    CHECK(strstr(b, "\"kind\":\"notification.read\",\"payload\":{\"notification_id\":\"n-9\"}") != NULL);
    CHECK(proto_action(b, sizeof b, id, ACT_FOCUS_START, NULL, "pomodoro") > 0);
    CHECK(strstr(b, "\"kind\":\"focus.start\",\"payload\":{\"mode\":\"pomodoro\"}") != NULL);
    CHECK(proto_action(b, sizeof b, id, ACT_FOCUS_START, NULL, NULL) > 0);
    CHECK(strstr(b, "\"kind\":\"focus.start\",\"payload\":{}") != NULL);
    CHECK(proto_action(b, sizeof b, id, ACT_FOCUS_PAUSE, NULL, NULL) > 0);
    CHECK(strstr(b, "\"kind\":\"focus.pause\",\"payload\":{}") != NULL);
    CHECK_EQ(proto_action(b, sizeof b, id, ACT_TASK_COMPLETE, NULL, NULL), 0); /* target required */
    CHECK(strcmp(act_kind_str(ACT_FOCUS_RESUME), "focus.resume") == 0 && strcmp(act_kind_str(ACT_FOCUS_STOP), "focus.stop") == 0);
    jload(&j, b);
    CHECK(jis(&j, 0, "type", "action"));

    CHECK(proto_command_ack(b, sizeof b, "c1", true, NULL) > 0);
    CHECK(strcmp(b, "{\"type\":\"command_ack\",\"id\":\"c1\",\"ok\":true}") == 0);
    CHECK(proto_command_ack(b, sizeof b, "c2", false, "WIFI_FAILED") > 0);
    CHECK(strcmp(b, "{\"type\":\"command_ack\",\"id\":\"c2\",\"ok\":false,\"error_code\":\"WIFI_FAILED\"}") == 0);

    wifi_seen_t nets[3] = { { "HomeNet", -48, true }, { "", -60, false }, { "Gu\"est", -71, false } };
    CHECK(proto_wifi_scan_result(b, sizeof b, "d4e5", nets, 3) > 0);
    jload(&j, b);
    CHECK(jis(&j, 0, "type", "wifi_scan_result") && jis(&j, 0, "id", "d4e5"));
    int a = jkey(&j, 0, "networks");
    CHECK(a > 0 && j.t[a].size == 2); /* hidden SSID dropped */
    int o1 = a + 1;
    CHECK(jis(&j, o1, "ssid", "HomeNet") && jis(&j, o1, "rssi", "-48") && jis(&j, o1, "secure", "true"));
    int o2 = jskip(&j, o1);
    CHECK(jis(&j, o2, "ssid", "Gu\\\"est") && jis(&j, o2, "rssi", "-71") && jis(&j, o2, "secure", "false"));
    /* too small for the second network: stays valid JSON with the first only */
    size_t full = strlen(b);
    char small[160];
    n = proto_wifi_scan_result(small, full - 10, "d4e5", nets, 3);
    CHECK(n > 0 && n < full - 10);
    jload(&j, small);
    CHECK_EQ(j.t[jkey(&j, 0, "networks")].size, 1);
    CHECK_EQ(proto_wifi_scan_result(small, 30, "d4e5", nets, 3), 0); /* not even the frame fits */
}

static void test_wifi_seen_merge(void)
{
    wifi_seen_t v[16] = { { "Home", -70, true }, { "Cafe", -50, false }, { "Home", -40, true }, { "", -30, true },
                          { "Guest", -80, false }, { "Cafe", -90, false }, { "Bad\xC3", -20, true } };
    int n = wifi_seen_merge(v, 7, 10);                   /* one entry per SSID, the strongest; hidden and non-UTF-8 dropped */
    CHECK_EQ(n, 3);
    CHECK(!strcmp(v[0].ssid, "Home") && v[0].rssi == -40 && v[0].secure);
    CHECK(!strcmp(v[1].ssid, "Cafe") && v[1].rssi == -50 && !v[1].secure);
    CHECK(!strcmp(v[2].ssid, "Guest") && v[2].rssi == -80);
    wifi_seen_t u[8] = { { "ok\xC3\xA9", -10, true }, { "s\xED\xA0\x80", -11, true }, { "f5\xF5\x80\x80\x80", -12, true },
                         { "ov\xE0\x80\x80", -13, true }, { "hi\xF4\x90\x80\x80", -14, true }, { "em\xF0\x9F\x98\x80", -15, true },
                         { "c0\xC0\xAF", -16, true }, { "cut\xE2\x82", -17, true } };
    CHECK_EQ(wifi_seen_merge(u, 8, 10), 2);              /* only the valid two-byte and four-byte names stay */
    CHECK(!strncmp(u[0].ssid, "ok", 2) && !strncmp(u[1].ssid, "em", 2));
    wifi_seen_t many[16];
    for (int i = 0; i < 16; i++) { snprintf(many[i].ssid, sizeof many[i].ssid, "n%d", i); many[i].rssi = (int8_t)(-90 + i); many[i].secure = true; }
    n = wifi_seen_merge(many, 16, 10);                   /* cut at max, strongest first */
    CHECK_EQ(n, 10);
    CHECK(!strcmp(many[0].ssid, "n15") && many[0].rssi == -75 && !strcmp(many[9].ssid, "n6"));
    CHECK_EQ(wifi_seen_merge(many, 0, 10), 0);
    wifi_seen_t one[1] = { { "Solo", -60, false } };
    CHECK_EQ(wifi_seen_merge(one, 1, 0), 0);
    wifi_seen_t tie[3] = { { "x", -60, false }, { "y", -60, true }, { "x", -60, true } };
    CHECK_EQ(wifi_seen_merge(tie, 3, 10), 2);            /* equal strength: stable, first seen first */
    CHECK(!strcmp(tie[0].ssid, "x") && !strcmp(tie[1].ssid, "y"));
}

static void test_wifi_state_escapes_ssid(void)
{
    char b[512];
    J j;
    wifi_list_t l;
    memset(&l, 0, sizeof l);
    l.n = 2;
    strcpy(l.net[0].ssid, "a\"b\\c");
    strcpy(l.net[0].pass, "SECRET-PASSWORD");
    strcpy(l.net[1].ssid, "Caf\xC3\xA9");
    CHECK(proto_wifi_state(b, sizeof b, &l, "a\"b\\c") > 0);
    CHECK(strstr(b, "SECRET") == NULL);               /* passwords never leave the board */
    CHECK(strstr(b, "\"saved\":[\"a\\\"b\\\\c\",\"Caf\xC3\xA9\"]") != NULL);
    jload(&j, b);
    CHECK(jis(&j, 0, "type", "wifi_state"));
    int s = jkey(&j, 0, "saved");
    CHECK(s > 0 && j.t[s].size == 2);
    CHECK(j.t[s + 1].type == JSMN_STRING && strncmp(b + j.t[s + 1].start, "a\\\"b\\\\c", 7) == 0 && j.t[s + 1].end - j.t[s + 1].start == 7);
    CHECK(jis(&j, 0, "current", "a\\\"b\\\\c"));
    CHECK(proto_wifi_state(b, sizeof b, &l, NULL) > 0);
    jload(&j, b);
    int cur = jkey(&j, 0, "current");
    CHECK(cur > 0 && j.t[cur].type == JSMN_PRIMITIVE && b[j.t[cur].start] == 'n');
    l.n = 0;
    CHECK(proto_wifi_state(b, sizeof b, &l, NULL) > 0);
    CHECK(strstr(b, "\"saved\":[]") != NULL);
    CHECK_EQ(proto_wifi_state(b, 20, &l, NULL), 0);
    /* an SSID that is not UTF-8 would make the server close the socket (1007) in a loop: skip it, and a bad current is null */
    l.n = 3;
    strcpy(l.net[0].ssid, "ok1");
    strcpy(l.net[1].ssid, "bad\xFF\xFE");
    strcpy(l.net[2].ssid, "ok2");
    CHECK(proto_wifi_state(b, sizeof b, &l, "bad\xFF") > 0);
    CHECK(strstr(b, "\"saved\":[\"ok1\",\"ok2\"]") != NULL && strstr(b, "\"current\":null") != NULL);
}

static void test_hello_with_contacts(void)
{
    char b[512];
    J j;
    /* empty or missing contacts: the key is absent (a v1 hello keeps what the server stored) */
    CHECK(proto_hello(b, sizeof b, "0.5.0", "board", "", "") > 0);
    CHECK(strstr(b, "contacts") == NULL);
    CHECK(proto_hello(b, sizeof b, "0.5.0", "board", NULL, "") > 0);
    CHECK(strstr(b, "contacts") == NULL);
    /* only one part present: only that key */
    CHECK(proto_hello(b, sizeof b, "0.5.0", "board", "", "@owner") > 0);
    jload(&j, b);
    int c = jkey(&j, 0, "contacts");
    CHECK(c > 0 && jis(&j, c, "telegram", "@owner") && jkey(&j, c, "phone") < 0);
    CHECK(proto_hello(b, sizeof b, "0.5.0", "board", "+7 700", NULL) > 0);
    jload(&j, b);
    c = jkey(&j, 0, "contacts");
    CHECK(c > 0 && jis(&j, c, "phone", "+7 700") && jkey(&j, c, "telegram") < 0);
    /* escaped, and the whole message is still valid JSON */
    CHECK(proto_hello(b, sizeof b, "0.5.0", "board", "a\"b\\c", "@o\nw") > 0);
    CHECK(strstr(b, "\"phone\":\"a\\\"b\\\\c\"") != NULL && strstr(b, "\"telegram\":\"@o\\u000aw\"") != NULL);
    jload(&j, b);
    CHECK(jkey(&j, 0, "contacts") > 0);
}

static void test_http_bodies(void)
{
    char id[40], nonce[80], tok[1024], code[32];
    const char *ch = "{\"challenge_id\":\"0a9f2c3e-8b7d-4e6f-a1b2-c3d4e5f60718\",\"nonce\":\"abc_DEF-123\",\"expires_at\":\"2026-11-13T09:30:00Z\"}";
    CHECK(proto_parse_challenge(ch, strlen(ch), id, nonce));
    CHECK(strcmp(id, "0a9f2c3e-8b7d-4e6f-a1b2-c3d4e5f60718") == 0 && strcmp(nonce, "abc_DEF-123") == 0);
    const char *bad[] = { "{}", "[]", "{\"challenge_id\":\"x\"}", "{\"nonce\":\"x\"}", "{\"challenge_id\":1,\"nonce\":\"n\"}",
                          "{\"challenge_id\":\"1234567890123456789012345678901234567890\",\"nonce\":\"n\"}", "nope", "" };
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) CHECK(!proto_parse_challenge(bad[i], strlen(bad[i]), id, nonce));

    const char *lg = "{\"access_token\":\"aaa.bbb.ccc\",\"refresh_token\":null,\"token_type\":\"bearer\",\"device_id\":\"d\"}";
    CHECK(proto_parse_login(lg, strlen(lg), tok, sizeof tok) && strcmp(tok, "aaa.bbb.ccc") == 0);
    const char *lg2 = "{\"access_token\":\"aaa.bbb.ccc\",\"refresh_token\":\"secret\"}"; /* a refresh token is never copied */
    CHECK(proto_parse_login(lg2, strlen(lg2), tok, sizeof tok) && strstr(tok, "secret") == NULL);
    CHECK(!proto_parse_login("{\"access_token\":\"\"}", 18, tok, sizeof tok));
    CHECK(!proto_parse_login("{\"token_type\":\"bearer\"}", 22, tok, sizeof tok));
    CHECK(!proto_parse_login(lg, strlen(lg), tok, 8));           /* does not fit: no truncated token */

    const char *e1 = "{\"detail\":{\"code\":\"UNAUTHORIZED\",\"message\":\"Unknown or revoked device\"}}";
    CHECK(proto_error_code(e1, strlen(e1), code) && strcmp(code, "UNAUTHORIZED") == 0);
    const char *e2 = "{\"detail\":\"Not Found\"}";               /* FastAPI default shape: no code */
    CHECK(!proto_error_code(e2, strlen(e2), code) && code[0] == '\0');
    const char *e3 = "{\"detail\":[{\"msg\":\"x\"}]}";
    CHECK(!proto_error_code(e3, strlen(e3), code));
    CHECK(!proto_error_code("<html>502</html>", 16, code));
}

int main(void)
{
    test_wifi_seen_merge();
    test_parses_every_contract_example();
    test_parses_v11_examples();
    test_snapshot_lists();
    test_fullest_snapshot_fits_the_token_table();
    test_command_unknown_name_is_not_rejected();
    test_snapshot_nulls_and_missing_optional();
    test_more_than_5_notices_keeps_first_5();
    test_command_rev();
    test_titles_cut_on_utf8_boundary();
    test_string_escapes_are_decoded();
    test_rejects();
    test_long_free_text_is_cut_not_rejected();
    test_command_bad_args_still_reports_id();
    test_built_messages_parse_as_json();
    test_wifi_state_escapes_ssid();
    test_hello_with_contacts();
    test_http_bodies();
    return g_failed ? 1 : 0;
}
