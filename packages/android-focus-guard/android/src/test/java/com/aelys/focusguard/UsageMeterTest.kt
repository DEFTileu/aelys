package com.aelys.focusguard

import com.aelys.focusguard.UsageEvent.Type
import org.junit.Assert.assertEquals
import org.junit.Test

class UsageMeterTest {
    private val yt = setOf("com.google.android.youtube")
    private val tiktok = setOf("com.zhiliaoapp.musically", "com.ss.android.ugc.trill")

    private fun ev(pkg: String, activity: String, type: Type, sec: Double) =
        UsageEvent(pkg, activity, type, (sec * 1000).toLong())

    private fun meter(events: List<UsageEvent>, group: Set<String>, from: Long = 0, to: Long = 1_000_000) =
        UsageMeter.foregroundSeconds(events, group, from, to)

    @Test
    fun resumeThenPauseCountsTheInterval() {
        val e = listOf(ev("com.google.android.youtube", "A", Type.RESUMED, 10.0), ev("com.google.android.youtube", "A", Type.PAUSED, 70.0))
        assertEquals(60L, meter(e, yt))
    }

    @Test
    fun twoActivitiesOfOnePackageDoNotDoubleCount() {
        val p = "com.google.android.youtube"
        val e = listOf(
            ev(p, "A", Type.RESUMED, 0.0), ev(p, "B", Type.RESUMED, 2.0),
            ev(p, "A", Type.PAUSED, 3.0), ev(p, "B", Type.PAUSED, 10.0),
        )
        assertEquals(10L, meter(e, yt))
    }

    @Test
    fun twoPackagesInOneGroupAreMerged() {
        val e = listOf(
            ev("com.zhiliaoapp.musically", "A", Type.RESUMED, 0.0),
            ev("com.ss.android.ugc.trill", "A", Type.RESUMED, 5.0),
            ev("com.zhiliaoapp.musically", "A", Type.PAUSED, 8.0),
            ev("com.ss.android.ugc.trill", "A", Type.PAUSED, 20.0),
        )
        assertEquals(20L, meter(e, tiktok))
    }

    @Test
    fun screenOffClosesOpenActivities() {
        val p = "com.google.android.youtube"
        val e = listOf(
            ev(p, "A", Type.RESUMED, 0.0), ev(p, "B", Type.RESUMED, 1.0),
            ev("", "", Type.SCREEN_OFF, 30.0),
        )
        assertEquals(30L, meter(e, yt))
    }

    @Test
    fun shutdownClosesOpenActivities() {
        val e = listOf(ev("com.google.android.youtube", "A", Type.RESUMED, 5.0), ev("", "", Type.SHUTDOWN, 45.0))
        assertEquals(40L, meter(e, yt))
    }

    @Test
    fun activityStillOpenAtNowCountsUntilNow() {
        val e = listOf(ev("com.google.android.youtube", "A", Type.RESUMED, 100.0))
        assertEquals(50L, meter(e, yt, to = 150_000))
    }

    @Test
    fun activityOpenBeforeFromIsClippedToFrom() {
        val e = listOf(ev("com.google.android.youtube", "A", Type.RESUMED, 10.0), ev("com.google.android.youtube", "A", Type.PAUSED, 100.0))
        assertEquals(40L, meter(e, yt, from = 60_000))
    }

    @Test
    fun ignoresPackagesOutsideTheGroup() {
        val e = listOf(ev("com.other", "A", Type.RESUMED, 0.0), ev("com.other", "A", Type.PAUSED, 50.0))
        assertEquals(0L, meter(e, yt))
    }

    @Test
    fun partialSecondsAreFlooredOnTheTotalNotPerInterval() {
        val p = "com.google.android.youtube"
        val e = listOf(
            ev(p, "A", Type.RESUMED, 0.0), ev(p, "A", Type.PAUSED, 1.6),
            ev(p, "A", Type.RESUMED, 10.0), ev(p, "A", Type.PAUSED, 11.6),
        )
        assertEquals(3L, meter(e, yt)) // 3.2s total, per-interval flooring would give 2
    }
}
