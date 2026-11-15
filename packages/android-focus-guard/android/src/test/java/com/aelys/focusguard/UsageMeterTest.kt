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

    // readEvents looks back before `from`, so a RESUMED earlier than the window reaches the meter.
    @Test
    fun lookbackResumeBeforeWindowCountsOnlyTheWindowPart() {
        val p = "com.google.android.youtube"
        val from = 10_000_000L
        val e = listOf(
            UsageEvent(p, "A", Type.RESUMED, from - 600_000),
            UsageEvent(p, "A", Type.PAUSED, from + 600_000),
        )
        assertEquals(600L, meter(e, yt, from = from, to = from + 3_600_000))
    }

    @Test
    fun lookbackResumeTwentyHoursBeforeFromStillOpenAtToIsClippedBothEnds() {
        val p = "com.google.android.youtube"
        val from = 100_000_000L
        val to = from + 1_800_000
        val e = listOf(UsageEvent(p, "A", Type.RESUMED, from - 20 * 3_600_000L))
        assertEquals(1800L, meter(e, yt, from = from, to = to))
    }

    @Test
    fun emptyOrInvertedWindowIsZero() {
        val e = listOf(ev("com.google.android.youtube", "A", Type.RESUMED, 0.0))
        assertEquals(0L, meter(e, yt, from = 5_000, to = 5_000))
        assertEquals(0L, meter(e, yt, from = 9_000, to = 5_000))
    }

    @Test
    fun unsortedEventsGiveTheSameResultAsSorted() {
        val p = "com.google.android.youtube"
        val sorted = listOf(
            ev(p, "A", Type.RESUMED, 0.0), ev(p, "B", Type.RESUMED, 2.0),
            ev(p, "A", Type.PAUSED, 3.0), ev(p, "B", Type.PAUSED, 10.0),
            ev(p, "A", Type.RESUMED, 20.0), ev(p, "A", Type.PAUSED, 25.0),
        )
        assertEquals(15L, meter(sorted, yt))
        assertEquals(15L, meter(sorted.reversed(), yt))
        assertEquals(15L, meter(listOf(sorted[3], sorted[0], sorted[5], sorted[2], sorted[4], sorted[1]), yt))
    }
}
