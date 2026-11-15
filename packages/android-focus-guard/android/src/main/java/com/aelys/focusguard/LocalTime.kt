package com.aelys.focusguard

import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

// java.time needs API 26 and minSdk is 24, so these use Calendar.

/** Local calendar day of [nowMs] in [tz] as ISO `yyyy-MM-dd`. */
fun localDay(nowMs: Long, tz: TimeZone = TimeZone.getDefault()): String {
    val c = Calendar.getInstance(tz).apply { timeInMillis = nowMs }
    return String.format(Locale.ROOT, "%04d-%02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
}

/** Epoch ms of the first instant of the local day containing [nowMs] in [tz] (DST-safe: a skipped midnight gives 01:00). */
fun startOfLocalDayMs(nowMs: Long, tz: TimeZone = TimeZone.getDefault()): Long {
    val c = Calendar.getInstance(tz).apply {
        timeInMillis = nowMs
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }
    return c.timeInMillis
}
