#pragma once
#include <stdint.h>

typedef enum {
    UI_EV_TOUCH = 1,
    UI_EV_BTN,
    UI_EV_COMBO_PROGRESS,
    UI_EV_COMBO_FIRE,
    UI_EV_TIME,
    UI_EV_WIFI,
    UI_EV_OWNER,
    UI_EV_LOST,
    UI_EV_TICK,
    /* appended by the companion link: never renumber the values above */
    UI_EV_TAP,          /* x, y: uint16 LE, as UI_EV_TOUCH */
    UI_EV_SWIPE_LEFT,
    UI_EV_SWIPE_RIGHT,
    UI_EV_SNAPSHOT,     /* [0] = 1 live / 0 cached; the data is in ui_snap_tb */
    UI_EV_LINK,         /* [0] = ui_link_state_t */
    UI_EV_PAIR,         /* [0] = ui_pair_t, [1..6] = ASCII digits for PAIR_UI_CODE */
    UI_EV_ACTION,       /* [0] = act_kind_t, [1] = ok, [2..25] = error code (NUL-terminated, "OFFLINE" when not sent) */
    UI_EV_FIND,         /* [0] = 1 show the "Here I am!" overlay (the board is beeping) / 0 hide it (the sound ended). Not a screen change; any touch, key or both-buttons hold in the ui task hides it by itself and stops the sound */
    UI_EV_WIFI_ADD,     /* [0] = 0 connecting / 1 connected / 2 failed / 3 take the card off (the attempt never ran), [1..33] = SSID, [34..59] = previous SSID (25 bytes, UTF-8 safe) */
    UI_EV_RELEASE,      /* the finger lifted, or moved 20 px or more (no payload): posted after the UI_EV_TAP / SWIPE of that touch, or alone when the touch was neither; may come twice per touch */
    UI_EV_BRIGHTNESS,   /* [0] = percent 5..100. Handled by main (the panel's SPI device belongs to the ui task), never reaches ui_handle_event */
} ui_event_type_t;

typedef struct {
    uint8_t type;
    uint8_t len;
    uint8_t data[62];
} ui_event_t;

_Static_assert(sizeof(ui_event_t) == 64, "ui_event_t");

/* UI_EV_BTN data[0]: a short click of one side key */
typedef enum { BTN_TOP = 1, BTN_LOW } ui_btn_t;

/* UI_EV_WIFI data[0] */
typedef enum { UI_WIFI_OFFLINE, UI_WIFI_CONNECTING, UI_WIFI_ONLINE, UI_WIFI_BAD_PASSWORD } ui_wifi_state_t;

/* UI_EV_LINK data[0] */
typedef enum { LINK_UI_UNPAIRED, LINK_UI_CONNECTING, LINK_UI_ONLINE, LINK_UI_OFFLINE } ui_link_state_t;

/* UI_EV_PAIR data[0]: CODE shows the six SAS digits (data[1..6]), DONE the "Paired" card, HIDE drops the pair screen. */
typedef enum { PAIR_UI_HIDE, PAIR_UI_CODE, PAIR_UI_DONE } ui_pair_t;
