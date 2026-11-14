#pragma once
#include "tribuf.h"
#include "ui_events.h"
extern tribuf_t ui_snap_tb;
bool lv_port_post(const ui_event_t *);
