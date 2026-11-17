#include <string.h>
#include "check.h"
#include "battery.h"

int main(void)
{
    char t[32];
    CHECK_EQ(battery_full_minutes(1000, 40, 61000, 41), -1);           /* one point: too little to tell */
    CHECK_EQ(battery_full_minutes(0, 40, 20 * 60000, 44), 280);        /* 4 points in 20 min, 56 to go */
    CHECK_EQ(battery_full_minutes(0, 60, 10 * 60000, 64), 90);         /* 4 points in 10 min, 36 to go */
    CHECK_EQ(battery_full_minutes(0xFFFFF000u, 60, 0xFFFFF000u + 600000u, 64), 90); /* the tick wraps */
    CHECK_EQ(battery_full_minutes(0, 60, 1000, 100), 0);
    battery_charge_text(t, sizeof t, 80, 64);
    CHECK(!strcmp(t, "Full in 1 h 20 min"));
    battery_charge_text(t, sizeof t, 45, 90);
    CHECK(!strcmp(t, "Full in 45 min"));
    battery_charge_text(t, sizeof t, -1, 50);
    CHECK(!strcmp(t, "Charging"));
    battery_charge_text(t, sizeof t, 0, 100);
    CHECK(!strcmp(t, "Charged"));
    return g_failed ? 1 : 0;
}
