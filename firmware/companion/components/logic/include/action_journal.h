#pragma once
/* Standalone prerequisite; no persistence or authorization is performed here.
 * V1: "AJNL", version, count, active uncompressed P-256 public key (65),
 * zero-padded device id (40), zero-padded API origin (129), four records,
 * then IEEE CRC-32 little-endian over all preceding bytes. Each record is
 * UUID ASCII (36), kind (1), zero-padded target (40), lost revision (u32 LE),
 * and epoch (u64 LE). Unused records must be all zero. No native struct bytes
 * are persisted. Records represent unresolved actions, never approvals.
 *
 * Device ID and origin are exact, case-sensitive bindings supplied from the
 * active pairing; origin must be an http(s) origin without credentials, path,
 * query or fragment. The caller validates the active P-256 key. Targets are
 * opaque identifiers, not titles or secrets; caller must supply only IDs.
 * Identical kind/target pairs and duplicate UUIDs are rejected. Focus actions
 * have empty targets; task/notification actions require nonempty targets.
 * Epoch meaning and recovery policy remain open for integration.
 *
 * CRC detects accidental corruption, not tampering. A successful encoding
 * does not prove an NVS write succeeded or was atomic. Integration must handle
 * failed/torn writes, preserve uncertain outcomes and fence identity changes;
 * this codec neither stores data nor decides when actions can be sent/applied. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ACTION_JOURNAL_CAPACITY 4u
#define ACTION_JOURNAL_BLOB_SIZE 600u
#define ACTION_JOURNAL_OWNER_SIZE 65u

typedef enum {
    ACTION_JOURNAL_NOTIFICATION_READ = 1, ACTION_JOURNAL_FOCUS_START = 2,
    ACTION_JOURNAL_FOCUS_PAUSE = 3, ACTION_JOURNAL_FOCUS_RESUME = 4,
    ACTION_JOURNAL_FOCUS_STOP = 5, ACTION_JOURNAL_TASK_COMPLETE = 6
} action_journal_kind_t;
typedef struct {
    char id[37];
    action_journal_kind_t kind;
    char target[40];
    uint32_t lost_rev;
    uint64_t epoch;
} action_journal_record_t;
typedef struct {
    uint8_t owner[ACTION_JOURNAL_OWNER_SIZE];
    char device_id[40];
    char api_origin[129];
} action_journal_binding_t;
typedef struct {
    size_t count;
    action_journal_record_t records[ACTION_JOURNAL_CAPACITY];
} action_journal_t;

/* Both functions leave their output untouched on failure. Inputs and output
 * must not overlap. Encode returns exact blob size on success, otherwise 0. */
size_t action_journal_encode(const action_journal_t *journal, const action_journal_binding_t *binding,
                             uint8_t *out, size_t capacity);
bool action_journal_decode(const uint8_t *blob, size_t size, const action_journal_binding_t *active,
                           action_journal_t *out);
