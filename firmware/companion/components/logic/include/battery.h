#pragma once
/* The charging card's "Full in ..." line: time to 100 % from how fast the charge rose since the charger went in. Pure C. */
#include <stddef.h>
#include <stdint.h>

#define BATTERY_LOW_PCT 15 /* under this, not charging: the low-battery card and the "no strength" face (design) */

/* Minutes until 100 %, or -1 while the rise since plugging in is under 2 points (too little to tell). */
int battery_full_minutes(uint32_t start_ms, uint8_t start_pct, uint32_t now_ms, uint8_t pct);
/* "Full in 1 h 20 min" / "Full in 45 min"; "Charged" at 100 %; "Charging" while minutes is -1. */
void battery_charge_text(char *out, size_t cap, int minutes, uint8_t pct);
