#include <stdint.h>
#include <string.h>
#include "check.h"
#include "ui_action_ledger.h"

static const char ids[6][37] = {
 "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002",
 "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004",
 "00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000006" };
static const ui_action_context_t ctx = {10, 20, 30};

static void test_capacity_duplicates_and_exact_matching(void)
{
    ui_action_ledger_t l; ui_action_entry_t out;
    ui_action_ledger_init(&l, ctx);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[0], 1, "same"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[1], 1, "same"), UI_ACTION_DUPLICATE);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[0], 2, "other"), UI_ACTION_DUPLICATE);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[1], 2, "same"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[2], 1, "other"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[3], 3, NULL), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[4], 4, "x"), UI_ACTION_FULL);
    memset(&out, 0x5a, sizeof out);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[5], &out), UI_ACTION_NOT_FOUND);
    CHECK_EQ(out.kind, 0x5a5a5a5a);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[2], &out), UI_ACTION_OK);
    CHECK(!memcmp(out.id, ids[2], 37) && out.kind == 1 && !strcmp(out.target, "other"));
    CHECK_EQ(out.context.identity, 10); CHECK_EQ(out.context.lost, 20); CHECK_EQ(out.context.ui, 30);
    CHECK_EQ(out.state, UI_ACTION_SETTLED);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[2], &out), UI_ACTION_ALREADY_SETTLED);
    CHECK_EQ(ui_action_ledger_release(&l, ids[2]), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[4], 4, "x"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[0], &out), UI_ACTION_OK);
    CHECK(!memcmp(out.id, ids[0], 37) && !strcmp(out.target, "same"));
}

static void test_timeout_and_late_result(void)
{
    ui_action_ledger_t l; ui_action_entry_t out;
    ui_action_ledger_init(&l, ctx);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[0], 1, "task"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_release(&l, ids[0]), UI_ACTION_UNRESOLVED);
    CHECK_EQ(ui_action_ledger_timeout(&l, ids[0]), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[1], 1, "task"), UI_ACTION_DUPLICATE);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[0], &out), UI_ACTION_OK);
    CHECK_EQ(out.state, UI_ACTION_SETTLED);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[1], 1, "task"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_timeout(&l, ids[1]), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_release(&l, ids[1]), UI_ACTION_UNRESOLVED);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[1], &out), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_release(&l, ids[1]), UI_ACTION_OK);
}

static void test_transitions_fence_old_responses_even_if_context_repeats(void)
{
    ui_action_ledger_t l; ui_action_entry_t out;
    ui_action_ledger_init(&l, ctx);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[0], 1, "old"), UI_ACTION_OK);
    ui_action_context_t lost = {10, 21, 31};
    CHECK_EQ(ui_action_ledger_transition(&l, lost), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[1], 1, "old"), UI_ACTION_DUPLICATE);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[1], 1, "new"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_transition(&l, ctx), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[2], 1, "latest"), UI_ACTION_OK);
    memset(&out, 0x5a, sizeof out);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[0], &out), UI_ACTION_STALE);
    CHECK_EQ(out.kind, 0x5a5a5a5a);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[1], &out), UI_ACTION_STALE);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[2], &out), UI_ACTION_OK);
    CHECK(!strcmp(out.target, "latest") && out.context.identity == 10);
    CHECK_EQ(ui_action_ledger_release(&l, ids[0]), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_release(&l, ids[1]), UI_ACTION_OK);
    ui_action_context_t identity = {11, 20, 30};
    CHECK_EQ(ui_action_ledger_admit(&l, ids[3], 2, "owner"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_transition(&l, identity), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[3], &out), UI_ACTION_STALE);
    CHECK_EQ(ui_action_ledger_release(&l, ids[3]), UI_ACTION_OK);
}

static void test_generation_exhaustion_preserves_ledger(void)
{
    ui_action_ledger_t l; ui_action_entry_t out;
    ui_action_ledger_init(&l, ctx);
    l.generation = UINT64_MAX - 1;
    CHECK_EQ(ui_action_ledger_transition(&l, ctx), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[0], 7, "last"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_transition(&l, (ui_action_context_t){99, 99, 99}), UI_ACTION_GENERATION_EXHAUSTED);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[0], &out), UI_ACTION_OK);
    CHECK_EQ(out.context.identity, 10);
}

static void test_preflight_is_read_only(void)
{
    ui_action_ledger_t l, before; ui_action_entry_t out;
    char long_target[41]; memset(long_target, 'x', 40); long_target[40] = 0;
    ui_action_ledger_init(&l, ctx);
    CHECK_EQ(ui_action_ledger_can_admit(&l, 1, NULL), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[0], 1, "task"), UI_ACTION_OK);
    memcpy(&before, &l, sizeof l);
    CHECK_EQ(ui_action_ledger_can_admit(&l, 1, "task"), UI_ACTION_DUPLICATE);
    CHECK(!memcmp(&l, &before, sizeof l));
    CHECK_EQ(ui_action_ledger_can_admit(&l, 1, long_target), UI_ACTION_INVALID);
    CHECK(!memcmp(&l, &before, sizeof l));
    CHECK_EQ(ui_action_ledger_can_admit(&l, 2, "task"), UI_ACTION_OK);
    CHECK(!memcmp(&l, &before, sizeof l));
    CHECK_EQ(ui_action_ledger_timeout(&l, ids[0]), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_can_admit(&l, 1, "task"), UI_ACTION_DUPLICATE);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[0], &out), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_can_admit(&l, 1, "task"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[1], 1, "task"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[2], 2, "x"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[3], 3, "x"), UI_ACTION_OK);
    memcpy(&before, &l, sizeof l);
    CHECK_EQ(ui_action_ledger_can_admit(&l, 9, "different"), UI_ACTION_FULL);
    CHECK(!memcmp(&l, &before, sizeof l));
    CHECK_EQ(ui_action_ledger_can_admit(&l, 1, "task"), UI_ACTION_DUPLICATE);
    CHECK(!memcmp(&l, &before, sizeof l));
}

static void test_identity_reset_after_transport_fence(void)
{
    ui_action_ledger_t l; ui_action_entry_t out;
    ui_action_context_t owner2 = {11, 40, 50};
    ui_action_ledger_init(&l, ctx);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[0], 1, "same"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[1], 2, "old"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_timeout(&l, ids[1]), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[2], 3, "settled"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[2], &out), UI_ACTION_OK);
    /* The caller has fenced the old transport before reset. */
    CHECK_EQ(ui_action_ledger_reset_for_new_identity(&l, owner2), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[3], 1, "same"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[0], &out), UI_ACTION_NOT_FOUND);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[1], &out), UI_ACTION_NOT_FOUND);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[2], &out), UI_ACTION_NOT_FOUND);
    CHECK_EQ(ui_action_ledger_settle(&l, ids[3], &out), UI_ACTION_OK);
    CHECK_EQ(out.context.identity, 11); CHECK_EQ(out.context.lost, 40); CHECK_EQ(out.context.ui, 50);
    l.generation = UINT64_MAX;
    CHECK_EQ(ui_action_ledger_reset_for_new_identity(&l, owner2), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_transition(&l, owner2), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_reset_for_new_identity(NULL, owner2), UI_ACTION_INVALID);
}

static void test_uuid_validation_and_event_bytes(void)
{
    ui_action_ledger_t l, before; ui_action_entry_t out;
    char event_id[37]; memcpy(event_id, ids[0], 36); event_id[36] = '\0';
    ui_action_ledger_init(&l, ctx); memcpy(&before, &l, sizeof l);
    CHECK_EQ(ui_action_ledger_can_admit(NULL, 1, "x"), UI_ACTION_INVALID);
    CHECK_EQ(ui_action_ledger_admit(&l, "short", 1, "x"), UI_ACTION_INVALID);
    CHECK_EQ(ui_action_ledger_admit(&l, "00000000-0000-4000-8000-000000000001x", 1, "x"), UI_ACTION_INVALID);
    CHECK_EQ(ui_action_ledger_admit(&l, "A0000000-0000-4000-8000-000000000001", 1, "x"), UI_ACTION_INVALID);
    CHECK_EQ(ui_action_ledger_admit(&l, "00000000-0000-4000-8000-00000000000z", 1, "x"), UI_ACTION_INVALID);
    CHECK_EQ(ui_action_ledger_admit(&l, "000000000000-4000-8000-000000000001", 1, "x"), UI_ACTION_INVALID);
    CHECK(!memcmp(&l, &before, sizeof l));
    CHECK_EQ(ui_action_ledger_admit(&l, ids[0], 1, "x"), UI_ACTION_OK);
    CHECK_EQ(ui_action_ledger_settle(&l, event_id, &out), UI_ACTION_OK);
    CHECK(!memcmp(out.id, ids[0], 37));
    memcpy(&before, &l, sizeof l);
    CHECK_EQ(ui_action_ledger_timeout(&l, "short"), UI_ACTION_INVALID);
    CHECK_EQ(ui_action_ledger_settle(&l, "short", &out), UI_ACTION_INVALID);
    CHECK_EQ(ui_action_ledger_release(&l, "short"), UI_ACTION_INVALID);
    CHECK(!memcmp(&l, &before, sizeof l));
}

static void test_validation(void)
{
    ui_action_ledger_t l; char long_target[41]; memset(long_target, 'x', 40); long_target[40] = 0;
    ui_action_ledger_init(&l, ctx);
    CHECK_EQ(ui_action_ledger_admit(&l, NULL, 1, "x"), UI_ACTION_INVALID);
    CHECK_EQ(ui_action_ledger_admit(&l, ids[0], 1, long_target), UI_ACTION_INVALID);
    CHECK_EQ(ui_action_ledger_timeout(&l, ids[5]), UI_ACTION_NOT_FOUND);
    CHECK_EQ(ui_action_ledger_release(&l, ids[5]), UI_ACTION_NOT_FOUND);
}

int main(void)
{
    test_capacity_duplicates_and_exact_matching();
    test_timeout_and_late_result();
    test_transitions_fence_old_responses_even_if_context_repeats();
    test_generation_exhaustion_preserves_ledger();
    test_preflight_is_read_only();
    test_identity_reset_after_transport_fence();
    test_uuid_validation_and_event_bytes();
    test_validation();
    return g_failed ? 1 : 0;
}
