#pragma once
/* Companion snapshot as the board keeps it. Pure C. Every string is NUL-terminated and cut on a UTF-8 boundary. */
#include <stdbool.h>
#include <stdint.h>

typedef struct { char id[40]; char title[65]; int64_t due; } snap_task_t;
typedef struct { char id[40]; char title[65]; int64_t starts, ends; bool all_day, has_end; } snap_event_t;
typedef struct { char id[40]; char kind[24]; char title[65]; int64_t created; } snap_notice_t;
typedef enum { FOCUS_NONE, FOCUS_ACTIVE, FOCUS_PAUSED } focus_status_t;
typedef struct { char id[40]; uint8_t status; char mode[16]; int64_t started; int32_t elapsed_s; } snap_focus_t;

typedef struct {
    int64_t generated;
    bool has_task, has_event;
    snap_task_t task;
    snap_event_t event;
    int16_t overdue, unread;
    int16_t other_unread;            /* -1 = server v1 */
    int16_t today_done, today_total; /* -1 = server v1 */
    uint8_t n_notices;
    snap_notice_t notices[5];
    snap_focus_t focus;              /* status FOCUS_NONE when the server sent none */
} snap_t;
