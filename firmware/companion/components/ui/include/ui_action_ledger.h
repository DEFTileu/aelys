#pragma once
/* Allocation-free, single-owner action bookkeeping; no transport or UI effects.
 * UUIDs are NUL-terminated, 36-character lowercase hexadecimal strings with
 * hyphens in the 8-4-4-4-12 positions, compared byte-for-byte. For a
 * UI_EV_ACTION copy its 36 UUID bytes into a 37-byte buffer and append NUL.
 * Callers MUST never reuse an operation UUID, even
 * after release, reconciliation, transition, reboot, or ledger reinitialization.
 * Serialize all calls externally. IDs/targets are copied; NULL target means "".
 * A successful preflight reserves nothing. The single owner must serialize the
 * entire preflight, sink send and admission with all other ledger operations,
 * transitions and response application. The sink must provide a valid fresh
 * UUID before admission. Preflight cannot detect duplicate or malformed IDs;
 * if admission unexpectedly fails after sending, the caller must treat the
 * sent action as unresolved and reconcile it, never assume it was not sent.
 *
 * Each identity, lost-mode, or UI epoch transition MUST be reported before
 * processing further responses, even if the context values repeat. A transition
 * fences all prior entries and marks admitted ones unknown. Stale results never
 * return an entry to apply. They settle their own tombstone, which still occupies
 * a slot until released. A timeout also remains unknown and blocks duplicates;
 * a late matching result can settle it. Four occupied slots cause admission to fail.
 * The caller must check UI_ACTION_OK immediately before applying a returned
 * result and serialize application with transitions. This is an in-memory ledger,
 * not durable storage, an id generator, a timer, or an authorization mechanism. */
#include <stdint.h>

#define UI_ACTION_LEDGER_CAPACITY 4
#define UI_ACTION_TARGET_CAPACITY 40

typedef struct { uint64_t identity, lost, ui; } ui_action_context_t;
typedef enum { UI_ACTION_ADMITTED, UI_ACTION_SETTLED, UI_ACTION_UNKNOWN } ui_action_state_t;
typedef struct {
    char id[37];
    uint32_t kind;
    char target[UI_ACTION_TARGET_CAPACITY];
    ui_action_context_t context;
    ui_action_state_t state;
    uint64_t generation;
} ui_action_entry_t;
typedef struct {
    ui_action_entry_t entries[UI_ACTION_LEDGER_CAPACITY];
    unsigned char occupied[UI_ACTION_LEDGER_CAPACITY];
    ui_action_context_t context;
    uint64_t generation;
} ui_action_ledger_t;
typedef enum {
    UI_ACTION_OK, UI_ACTION_INVALID, UI_ACTION_FULL, UI_ACTION_DUPLICATE,
    UI_ACTION_NOT_FOUND, UI_ACTION_UNRESOLVED, UI_ACTION_ALREADY_SETTLED,
    UI_ACTION_STALE, UI_ACTION_GENERATION_EXHAUSTED
} ui_action_result_t;

void ui_action_ledger_init(ui_action_ledger_t *ledger, ui_action_context_t context);
/* Read-only preflight: validates target and checks capacity and unresolved
 * kind/target duplicates. It cannot validate an ID or reserve a slot. */
ui_action_result_t ui_action_ledger_can_admit(const ui_action_ledger_t *ledger, uint32_t kind, const char *target);
/* Failure leaves the ledger unchanged; same kind/target is blocked while unknown or admitted. */
ui_action_result_t ui_action_ledger_admit(ui_action_ledger_t *ledger, const char *id,
                                          uint32_t kind, const char *target);
/* Discards all entries and starts a new context. ONLY call after the transport
 * has fenced old identity sends/retries and the caller has fenced queued or
 * in-flight result application from that identity. Serialize this with all
 * preflight/send/admit and result processing. Old results arriving afterward
 * must not be applied; globally fresh UUIDs ensure they cannot match new work.
 * The caller assumes responsibility for the unknown outcomes being discarded.
 * This also resets generation, including after generation exhaustion. */
ui_action_result_t ui_action_ledger_reset_for_new_identity(ui_action_ledger_t *ledger, ui_action_context_t context);
/* On generation exhaustion the ledger is unchanged; stop admitting/applying actions. */
ui_action_result_t ui_action_ledger_transition(ui_action_ledger_t *ledger, ui_action_context_t context);
ui_action_result_t ui_action_ledger_timeout(ui_action_ledger_t *ledger, const char *id);
/* Only OK writes *out; STALE consumes the old result without exposing it. */
ui_action_result_t ui_action_ledger_settle(ui_action_ledger_t *ledger, const char *id, ui_action_entry_t *out);
/* Release requires a definitive settled result. */
ui_action_result_t ui_action_ledger_release(ui_action_ledger_t *ledger, const char *id);
