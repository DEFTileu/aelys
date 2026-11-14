#include "character_report.h"
#include <limits.h>
#include <stdio.h>
#include <inttypes.h>
#include <stddef.h>

/* ESP-IDF Xtensa reports ATOMIC_INT_LOCK_FREE=1 for the operation family;
 * the 32-bit atomic loads and stores compile to aligned s32i/l32i + memw, without calls. */
static const char *const moods[] = {
    "calm", "attention", "focused", "flow", "joy", "elation", "pride", "relief", "anxiety", "panic", "sad",
    "disappointed", "anticipation", "thinking", "curious", "surprised", "frightened", "tickled", "tender",
    "bashful", "irritated", "dizzy", "mischief", "waking", "bored", "missed", "sleepy", "sleeping",
    "exhausted", "charging", "offline", "reconnected"
};
static const char *const reasons[] = {
    "calm", "face_down", "night_sleep", "shake", "fall", "turn", "low_battery", "charging", "touch",
    "double_touch", "stroke", "pokes", "notification", "loud", "task_done", "last_task", "task_near_deadline",
    "lift", "reconnected", "wake", "tilt", "deadline_panic", "deadline_anxiety", "overdue", "flow", "focus",
    "calendar", "waiting", "offline", "all_done", "clear_week", "bored", "missed", "morning", "evening",
    "idle_attention", "idle_mischief", "hold", "reschedule"
};
_Static_assert(sizeof moods / sizeof *moods == CHAR_MOOD_COUNT, "all moods need wire codes");
_Static_assert(sizeof reasons / sizeof *reasons == WHY_RESCHEDULE + 1, "all reasons need wire codes");
const char *character_mood_code(character_mood_t mood)
{
    return (unsigned)mood < CHAR_MOOD_COUNT ? moods[mood] : NULL;
}
const char *character_reason_code(character_reason_t why)
{
    return (unsigned)why < sizeof reasons / sizeof *reasons ? reasons[why] : NULL;
}
void character_report_offer(character_report_mailbox_t *box, character_mood_t mood, character_reason_t why, uint32_t lost_rev, uint32_t identity)
{
    if (!character_mood_code(mood) || !character_reason_code(why)) return;
    unsigned code = 1u + ((unsigned)why << 8) + (unsigned)mood;
    /* UI is the only writer. Odd versions denote a publication in progress;
     * a reader never waits and only accepts a coherent code/revision pair. */
    unsigned version = atomic_load(&box->version);
    atomic_store(&box->version, version + 1u);
    atomic_store(&box->value, code);
    atomic_store(&box->lost_rev, lost_rev);
    atomic_store(&box->identity, identity);
    atomic_store(&box->version, version + 2u);
}
void character_report_init(character_report_t *sender) { *sender = (character_report_t){0}; }
void character_report_reset(character_report_t *sender) { character_report_init(sender); }
bool character_report_prepare(character_report_t *sender, const character_report_mailbox_t *box, bool lost,
                              uint32_t lost_rev, uint32_t identity, character_report_frame_t *frame)
{
    unsigned before = atomic_load(&box->version);
    if (before & 1u) return false;
    unsigned code = atomic_load(&box->value), observed_rev = atomic_load(&box->lost_rev);
    unsigned observed_identity = atomic_load(&box->identity);
    if (before != atomic_load(&box->version) || observed_rev != lost_rev || observed_identity != identity) return false;
    if (lost || !code || (code == sender->sent_code && lost_rev == sender->sent_lost_rev) ||
        sender->next_seq > UINT32_MAX) return false;
    unsigned value = code - 1;
    *frame = (character_report_frame_t){.seq = (uint32_t)sender->next_seq++, .lost_rev = lost_rev, .code = code,
                                       .mood = (character_mood_t)(value & 255u), .why = (character_reason_t)(value >> 8)};
    return true;
}
void character_report_finish(character_report_t *sender, const character_report_frame_t *frame, bool sent)
{
    if (sent) { sender->sent_code = frame->code; sender->sent_lost_rev = frame->lost_rev; }
}

size_t character_report_json(char *dst, size_t cap, const character_report_frame_t *frame)
{
    const char *mood = character_mood_code(frame->mood), *reason = character_reason_code(frame->why);
    if (!dst || !cap || !mood || !reason) return 0;
    int n = snprintf(dst, cap, "{\"type\":\"character_state\",\"seq\":%" PRIu32
                     ",\"lost_rev\":%" PRIu32 ",\"mood\":\"%s\",\"reason\":\"%s\"}",
                     frame->seq, frame->lost_rev, mood, reason);
    return n > 0 && (size_t)n < cap ? (size_t)n : 0;
}
