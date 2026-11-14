#pragma once
/* Companion snapshot as the board keeps it. Pure C. Every string is NUL-terminated and cut on a UTF-8 boundary. */
#include <stdbool.h>
#include <stdint.h>

typedef struct { char id[40]; char title[65]; int64_t due; } snap_task_t;
typedef struct { char id[40]; char title[65]; int64_t starts, ends; bool all_day, has_end; } snap_event_t;
typedef struct { char id[40]; char kind[24]; char title[65]; int64_t created; } snap_notice_t;
typedef struct { uint8_t hour, code; int8_t temp; } snap_hour_t; /* hour: the city's local hour 0..23; temp: Celsius; code: WMO */
typedef struct {
    int64_t updated;                 /* when the server fetched the forecast */
    bool present;                    /* false: the server sent no weather (no city, no data, an older server, lost mode) */
    int8_t temp, hi, lo;             /* Celsius now, today's high and low */
    uint8_t code;                    /* WMO weather code now */
    uint8_t n_hours;
    snap_hour_t hours[5];            /* the next hours, at most SNAP_MAX_HOURS (5) */
} snap_weather_t;
typedef enum { FOCUS_NONE, FOCUS_ACTIVE, FOCUS_PAUSED } focus_status_t;
typedef struct { char id[40]; uint8_t status; char mode[16]; int64_t started; int32_t elapsed_s; } snap_focus_t;

#define SNAP_MAX_TASKS 5  /* tasks_today: open tasks due today or overdue (server v1.2) */
#define SNAP_MAX_EVENTS 4 /* events_upcoming: from now to the end of tomorrow (server v1.2) */
#define SNAP_MAX_HOURS 5  /* weather.hours (server v1.3) */

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
    uint8_t n_tasks, n_events;       /* 0 = the server sent no list (v1, or nothing in it): screens fall back to task / event above */
    snap_task_t tasks[SNAP_MAX_TASKS];
    snap_event_t events[SNAP_MAX_EVENTS];
    snap_weather_t weather;          /* present == false when the server sent none */
} snap_t;
