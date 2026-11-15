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
     * [events] must be sorted by time. The group counts as foreground while at least one
     * of its (package, activity) pairs is open, so overlapping activities or sibling
     * packages never double-count. Seconds are floored once on the total, not per interval.
     */
    fun foregroundSeconds(events: List<UsageEvent>, packages: Set<String>, fromMs: Long, toMs: Long): Long {
        val open = HashSet<Pair<String, String>>()
        var totalMs = 0L
        var last = fromMs
        for (e in events) {
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
}

/** Thin mapping of the system usage log; all logic lives in [UsageMeter]. Needs PACKAGE_USAGE_STATS. */
@Suppress("DEPRECATION") // MOVE_TO_* are the only constants below API 29
fun readEvents(context: Context, fromMs: Long, toMs: Long): List<UsageEvent> {
    val manager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    val resumed = if (Build.VERSION.SDK_INT >= 29) UsageEvents.Event.ACTIVITY_RESUMED else UsageEvents.Event.MOVE_TO_FOREGROUND
    val paused = if (Build.VERSION.SDK_INT >= 29) UsageEvents.Event.ACTIVITY_PAUSED else UsageEvents.Event.MOVE_TO_BACKGROUND
    val out = ArrayList<UsageEvent>()
    val raw = manager.queryEvents(fromMs, toMs)
    val ev = UsageEvents.Event()
    while (raw.hasNextEvent()) {
        raw.getNextEvent(ev)
        val type = when (ev.eventType) {
            resumed -> UsageEvent.Type.RESUMED
            paused -> UsageEvent.Type.PAUSED
            UsageEvents.Event.SCREEN_NON_INTERACTIVE -> UsageEvent.Type.SCREEN_OFF
            UsageEvents.Event.DEVICE_SHUTDOWN -> UsageEvent.Type.SHUTDOWN
            else -> continue
        }
        out.add(UsageEvent(ev.packageName.orEmpty(), ev.className.orEmpty(), type, ev.timeStamp))
    }
    return out
}
