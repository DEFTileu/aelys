package com.aelys.focusguard

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build

data class UsageEvent(val pkg: String, val activity: String, val type: Type, val timeMs: Long) {
    enum class Type { RESUMED, PAUSED, SCREEN_OFF, SHUTDOWN }
}

object UsageMeter {
    /**
     * Whole seconds the apps in [packages] were in the foreground within [fromMs, toMs].
     * Intervals are clipped to the window, so [events] may start before [fromMs] (see
     * [readEvents]'s lookback). Events are stably sorted by time first, so order never
     * matters. An empty or inverted window yields 0. The group counts as foreground while at least one
     * of its (package, activity) pairs is open, so overlapping activities or sibling
     * packages never double-count. Seconds are floored once on the total, not per interval.
     */
    fun foregroundSeconds(events: List<UsageEvent>, packages: Set<String>, fromMs: Long, toMs: Long): Long {
        if (toMs <= fromMs) return 0
        val open = HashSet<Pair<String, String>>()
        var totalMs = 0L
        var last = fromMs
        for (e in events.sortedBy { it.timeMs }) {
            val t = e.timeMs.coerceIn(fromMs, toMs)
            if (open.isNotEmpty()) totalMs += t - last
            last = t
            when (e.type) {
                UsageEvent.Type.SCREEN_OFF, UsageEvent.Type.SHUTDOWN -> open.clear()
                UsageEvent.Type.RESUMED -> if (e.pkg in packages) open.add(e.pkg to e.activity)
                UsageEvent.Type.PAUSED -> if (e.pkg in packages) open.remove(e.pkg to e.activity)
            }
        }
        if (open.isNotEmpty()) totalMs += toMs - last
        return totalMs / 1000
    }

    /**
     * Maps a `UsageEvents.Event` type to ours, or null to skip it. RESUMED/PAUSED below API 29 are the same
     * ints as MOVE_TO_FOREGROUND/BACKGROUND. ACTIVITY_STOPPED (API 29+) also closes the interval, so a
     * crashed or destroyed activity that never logged PAUSED stops counting.
     */
    @Suppress("DEPRECATION") // MOVE_TO_* are the only constants below API 29
    fun mapType(type: Int, sdkInt: Int): UsageEvent.Type? = when {
        type == (if (sdkInt >= 29) UsageEvents.Event.ACTIVITY_RESUMED else UsageEvents.Event.MOVE_TO_FOREGROUND) -> UsageEvent.Type.RESUMED
        type == (if (sdkInt >= 29) UsageEvents.Event.ACTIVITY_PAUSED else UsageEvents.Event.MOVE_TO_BACKGROUND) -> UsageEvent.Type.PAUSED
        sdkInt >= 29 && type == UsageEvents.Event.ACTIVITY_STOPPED -> UsageEvent.Type.PAUSED
        type == UsageEvents.Event.SCREEN_NON_INTERACTIVE -> UsageEvent.Type.SCREEN_OFF
        type == UsageEvents.Event.DEVICE_SHUTDOWN -> UsageEvent.Type.SHUTDOWN
        else -> null
    }
}

/** How far before `fromMs` [readEvents] looks, so activities already open at the window start are seen. */
const val LOOKBACK_MS = 24 * 60 * 60 * 1000L

/**
 * Thin mapping of the system usage log; all logic lives in [UsageMeter]. Needs PACKAGE_USAGE_STATS.
 * Queries from `fromMs - LOOKBACK_MS` and keeps raw timestamps, so a RESUMED before `fromMs` is
 * returned and [UsageMeter.foregroundSeconds] clips the interval to `[fromMs, toMs]`.
 */
fun readEvents(context: Context, fromMs: Long, toMs: Long): List<UsageEvent> {
    val manager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    val out = ArrayList<UsageEvent>()
    val raw = manager.queryEvents(fromMs - LOOKBACK_MS, toMs)
    val ev = UsageEvents.Event()
    while (raw.hasNextEvent()) {
        raw.getNextEvent(ev)
        val type = UsageMeter.mapType(ev.eventType, Build.VERSION.SDK_INT) ?: continue
        out.add(UsageEvent(ev.packageName.orEmpty(), ev.className.orEmpty(), type, ev.timeStamp))
    }
    return out
}
