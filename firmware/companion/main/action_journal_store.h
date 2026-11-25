#pragma once
#include <stdbool.h>
#include "action_journal.h"

/* Standalone prerequisite: the caller initializes NVS and serializes every
 * access, including pairing/identity changes. No NVS initialization, erase,
 * authorization, replay, or app integration is performed here. */
typedef enum {
    ACTION_JOURNAL_STORE_OK,
    ACTION_JOURNAL_STORE_NOT_FOUND,
    ACTION_JOURNAL_STORE_IO_ERROR,
    ACTION_JOURNAL_STORE_INVALID,
    ACTION_JOURNAL_STORE_OWNER_MISMATCH
} action_journal_store_result_t;

typedef struct { bool uncertain; } action_journal_store_t;
#define ACTION_JOURNAL_STORE_INIT { false }

/* On any non-OK result, out is untouched. NOT_FOUND means namespace or key
 * absent, never an I/O failure. Binding includes public key, device and origin.
 * Caller validates the active P-256 key and prevents simultaneous access. */
action_journal_store_result_t action_journal_store_load(action_journal_store_t *store,
    const action_journal_binding_t *binding, action_journal_t *out);

/* Refuses to overwrite unreadable, invalid or foreign data. A set/commit error
 * latches the instance uncertain: subsequent loads and saves return IO_ERROR.
 * Even a failed commit may have written data. Do not reset this latch in a
 * running system; integration must fence actions and define reboot recovery.
 * A successful call is only an NVS API result, not proof of power-loss atomicity.
 * No erase or automatic recovery is attempted. */
action_journal_store_result_t action_journal_store_save(action_journal_store_t *store,
    const action_journal_binding_t *binding, const action_journal_t *journal);
