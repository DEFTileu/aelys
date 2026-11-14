#pragma once
/* UI publishes a coherent atomic code/revision/identity tuple; the link task alone owns the sender. No text crosses the task boundary. */
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "character.h"

typedef struct { atomic_uint version, value, lost_rev, identity; } character_report_mailbox_t;
#define CHARACTER_REPORT_MAILBOX_INIT { ATOMIC_VAR_INIT(0), ATOMIC_VAR_INIT(0), ATOMIC_VAR_INIT(0), ATOMIC_VAR_INIT(0) }
typedef struct { uint64_t next_seq; uint32_t sent_code, sent_lost_rev; } character_report_t;
typedef struct { uint32_t seq, lost_rev, code; character_mood_t mood; character_reason_t why; } character_report_frame_t;
void character_report_offer(character_report_mailbox_t *box, character_mood_t mood, character_reason_t why, uint32_t lost_rev, uint32_t identity);
void character_report_init(character_report_t *sender);
void character_report_reset(character_report_t *sender);
bool character_report_prepare(character_report_t *sender, const character_report_mailbox_t *box, bool lost,
                              uint32_t lost_rev, uint32_t identity, character_report_frame_t *frame);
void character_report_finish(character_report_t *sender, const character_report_frame_t *frame, bool sent);
size_t character_report_json(char *dst, size_t cap, const character_report_frame_t *frame);
const char *character_mood_code(character_mood_t mood);
const char *character_reason_code(character_reason_t reason);
