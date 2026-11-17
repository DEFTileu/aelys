#include "battery.h"
#include <stdio.h>

int battery_full_minutes(uint32_t start_ms, uint8_t start_pct, uint32_t now_ms, uint8_t pct)
{
    if (pct >= 100) return 0;
    if (pct < start_pct + 2u) return -1;
    uint64_t elapsed = (uint32_t)(now_ms - start_ms);
    uint64_t left_ms = elapsed * (100u - pct) / (pct - start_pct);
    return (int)((left_ms + 59999u) / 60000u); /* round up: "Full in 0 min" never shows before 100 % */
}

void battery_charge_text(char *out, size_t cap, int minutes, uint8_t pct)
{
    if (pct >= 100) snprintf(out, cap, "Charged");
    else if (minutes < 0) snprintf(out, cap, "Charging");
    else if (minutes >= 60) snprintf(out, cap, "Full in %d h %d min", minutes / 60, minutes % 60);
    else snprintf(out, cap, "Full in %d min", minutes);
}
