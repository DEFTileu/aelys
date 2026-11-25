#include "ui_action_ledger.h"
#include <stddef.h>
#include <string.h>

static int valid_id(const char *id)
{
    if (!id) return 0;
    for (size_t i = 0; i < 36; ++i) {
        char c = id[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != '-') return 0;
        } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
    }
    return id[36] == '\0';
}

static size_t find_id(const ui_action_ledger_t *l, const char *id)
{
    for (size_t i = 0; i < UI_ACTION_LEDGER_CAPACITY; ++i)
        if (l->occupied[i] && memcmp(l->entries[i].id, id, 37) == 0) return i;
    return UI_ACTION_LEDGER_CAPACITY;
}

void ui_action_ledger_init(ui_action_ledger_t *l, ui_action_context_t context)
{
    if (!l) return;
    memset(l, 0, sizeof *l);
    l->context = context;
}

ui_action_result_t ui_action_ledger_can_admit(const ui_action_ledger_t *l, uint32_t kind, const char *target)
{
    if (!l) return UI_ACTION_INVALID;
    if (!target) target = "";
    size_t len = 0;
    while (len < UI_ACTION_TARGET_CAPACITY && target[len]) ++len;
    if (len == UI_ACTION_TARGET_CAPACITY) return UI_ACTION_INVALID;
    int has_slot = 0;
    for (size_t i = 0; i < UI_ACTION_LEDGER_CAPACITY; ++i) {
        if (!l->occupied[i]) { has_slot = 1; continue; }
        const ui_action_entry_t *e = &l->entries[i];
        if (e->state != UI_ACTION_SETTLED && e->kind == kind && !strcmp(e->target, target))
            return UI_ACTION_DUPLICATE;
    }
    return has_slot ? UI_ACTION_OK : UI_ACTION_FULL;
}

ui_action_result_t ui_action_ledger_admit(ui_action_ledger_t *l, const char *id,
                                          uint32_t kind, const char *target)
{
    if (!l || !valid_id(id)) return UI_ACTION_INVALID;
    if (find_id(l, id) != UI_ACTION_LEDGER_CAPACITY) return UI_ACTION_DUPLICATE;
    ui_action_result_t result = ui_action_ledger_can_admit(l, kind, target);
    if (result != UI_ACTION_OK) return result;
    if (!target) target = "";
    size_t i = 0;
    while (l->occupied[i]) ++i;
    ui_action_entry_t *e = &l->entries[i];
    memset(e, 0, sizeof *e);
    memcpy(e->id, id, sizeof e->id);
    memcpy(e->target, target, strlen(target) + 1);
    e->kind = kind; e->context = l->context; e->generation = l->generation; e->state = UI_ACTION_ADMITTED;
    l->occupied[i] = 1;
    return UI_ACTION_OK;
}

ui_action_result_t ui_action_ledger_reset_for_new_identity(ui_action_ledger_t *l, ui_action_context_t context)
{
    if (!l) return UI_ACTION_INVALID;
    ui_action_ledger_init(l, context);
    return UI_ACTION_OK;
}

ui_action_result_t ui_action_ledger_transition(ui_action_ledger_t *l, ui_action_context_t context)
{
    if (!l) return UI_ACTION_INVALID;
    if (l->generation == UINT64_MAX) return UI_ACTION_GENERATION_EXHAUSTED;
    ++l->generation;
    l->context = context;
    for (size_t i = 0; i < UI_ACTION_LEDGER_CAPACITY; ++i)
        if (l->occupied[i] && l->entries[i].state == UI_ACTION_ADMITTED) l->entries[i].state = UI_ACTION_UNKNOWN;
    return UI_ACTION_OK;
}

ui_action_result_t ui_action_ledger_timeout(ui_action_ledger_t *l, const char *id)
{
    if (!l || !valid_id(id)) return UI_ACTION_INVALID;
    size_t i = find_id(l, id);
    if (i == UI_ACTION_LEDGER_CAPACITY) return UI_ACTION_NOT_FOUND;
    if (l->entries[i].state == UI_ACTION_SETTLED) return UI_ACTION_ALREADY_SETTLED;
    l->entries[i].state = UI_ACTION_UNKNOWN;
    return UI_ACTION_OK;
}

ui_action_result_t ui_action_ledger_settle(ui_action_ledger_t *l, const char *id, ui_action_entry_t *out)
{
    if (!l || !out || !valid_id(id)) return UI_ACTION_INVALID;
    size_t i = find_id(l, id);
    if (i == UI_ACTION_LEDGER_CAPACITY) return UI_ACTION_NOT_FOUND;
    ui_action_entry_t *e = &l->entries[i];
    if (e->state == UI_ACTION_SETTLED) return UI_ACTION_ALREADY_SETTLED;
    e->state = UI_ACTION_SETTLED;
    if (e->generation != l->generation) return UI_ACTION_STALE;
    *out = *e;
    return UI_ACTION_OK;
}

ui_action_result_t ui_action_ledger_release(ui_action_ledger_t *l, const char *id)
{
    if (!l || !valid_id(id)) return UI_ACTION_INVALID;
    size_t i = find_id(l, id);
    if (i == UI_ACTION_LEDGER_CAPACITY) return UI_ACTION_NOT_FOUND;
    if (l->entries[i].state != UI_ACTION_SETTLED) return UI_ACTION_UNRESOLVED;
    memset(&l->entries[i], 0, sizeof l->entries[i]); l->occupied[i] = 0;
    return UI_ACTION_OK;
}
