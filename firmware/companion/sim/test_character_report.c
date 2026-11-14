#include <stdatomic.h>
#include <pthread.h>
#include <string.h>
#include "character_report.h"
#include "check.h"

static character_report_mailbox_t concurrent = CHARACTER_REPORT_MAILBOX_INIT;
static void *writer(void *unused)
{
    (void)unused;
    for (int i = 0; i < 100000; i++) {
        if (i & 1) character_report_offer(&concurrent, CHAR_CALM, WHY_CALM, 0, 0);
        else character_report_offer(&concurrent, CHAR_JOY, WHY_TASK_DONE, 0, 0);
    }
    return NULL;
}
static void concurrent_mailbox(void)
{
    pthread_t task; character_report_t sender; character_report_frame_t frame;
    character_report_init(&sender);
    CHECK_EQ(pthread_create(&task, NULL, writer, NULL), 0);
    for (int i = 0; i < 100000; i++) {
        if (character_report_prepare(&sender, &concurrent, false, 0, 0, &frame)) {
            CHECK((frame.mood == CHAR_CALM && frame.why == WHY_CALM) ||
                  (frame.mood == CHAR_JOY && frame.why == WHY_TASK_DONE));
            character_report_finish(&sender, &frame, true);
        }
    }
    CHECK_EQ(pthread_join(task, NULL), 0);
}

int main(void)
{
    character_report_mailbox_t mailbox = CHARACTER_REPORT_MAILBOX_INIT;
    character_report_t sender; character_report_init(&sender);
    character_report_frame_t frame;
    CHECK(!character_report_prepare(&sender, &mailbox, false, 0, 0, &frame));
    character_report_offer(&mailbox, CHAR_JOY, WHY_TASK_DONE, 0, 0);
    CHECK(!character_report_prepare(&sender, &mailbox, true, 1, 0, &frame));
    CHECK(character_report_prepare(&sender, &mailbox, false, 0, 0, &frame));
    CHECK_EQ(frame.seq, 0); CHECK_EQ(frame.mood, CHAR_JOY); CHECK_EQ(frame.why, WHY_TASK_DONE);
    char json[160];
    CHECK(character_report_json(json, sizeof json, &frame) > 0);
    CHECK(!strcmp(json, "{\"type\":\"character_state\",\"seq\":0,\"lost_rev\":0,\"mood\":\"joy\",\"reason\":\"task_done\"}"));
    CHECK_EQ(character_report_json(json, 4, &frame), 0);
    CHECK(!strcmp(character_mood_code(frame.mood), "joy"));
    CHECK(!strcmp(character_reason_code(frame.why), "task_done"));
    character_report_finish(&sender, &frame, false);
    CHECK(character_report_prepare(&sender, &mailbox, false, 0, 0, &frame));
    CHECK_EQ(frame.seq, 1); /* uncertain delivery must not reuse a sequence */
    character_report_offer(&mailbox, CHAR_CALM, WHY_CALM, 0, 0);
    character_report_finish(&sender, &frame, true); /* an update raced with send */
    CHECK(character_report_prepare(&sender, &mailbox, false, 0, 0, &frame));
    CHECK_EQ(frame.seq, 2); CHECK_EQ(frame.mood, CHAR_CALM);
    character_report_finish(&sender, &frame, true);
    CHECK(!character_report_prepare(&sender, &mailbox, false, 0, 0, &frame));
    CHECK(!character_report_prepare(&sender, &mailbox, false, 2, 0, &frame)); /* observation predates lost-mode change */
    character_report_offer(&mailbox, CHAR_CALM, WHY_CALM, 2, 0);
    CHECK(character_report_prepare(&sender, &mailbox, false, 2, 0, &frame));
    CHECK_EQ(frame.lost_rev, 2); character_report_finish(&sender, &frame, true);
    character_report_reset(&sender);
    CHECK(!character_report_prepare(&sender, &mailbox, false, 2, 1, &frame)); /* new identity must not reuse old status */
    character_report_offer(&mailbox, CHAR_CALM, WHY_CALM, 2, 1);
    CHECK(character_report_prepare(&sender, &mailbox, false, 2, 1, &frame));
    CHECK_EQ(frame.seq, 0); /* reconnect resends even unchanged data */
    CHECK(character_mood_code(CHAR_MOOD_COUNT) == NULL);
    CHECK(character_reason_code((character_reason_t)999) == NULL);
    concurrent_mailbox();
    return g_failed ? 1 : 0;
}
