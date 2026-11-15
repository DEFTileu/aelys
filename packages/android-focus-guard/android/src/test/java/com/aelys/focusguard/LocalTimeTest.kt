package com.aelys.focusguard

import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Test

class LocalTimeTest {
    private val almaty = TimeZone.getTimeZone("Asia/Almaty")
    private val la = TimeZone.getTimeZone("America/Los_Angeles")
    private val utc = TimeZone.getTimeZone("UTC")

    // 2026-03-08 10:00:00 UTC; Almaty is UTC+5 (15:00), Los Angeles is already on PDT (UTC-7, 03:00).
    private val now = 1_772_964_000_000L

    @Test
    fun localDayFollowsTheZone() {
        assertEquals("2026-03-08", localDay(now, utc))
        assertEquals("2026-03-08", localDay(now, almaty))
        assertEquals("2026-03-08", localDay(now, la))
        // 2026-03-08 22:00 UTC is already the 9th in Almaty (03:00) and still the 8th in Los Angeles.
        val late = now + 12 * 3_600_000L
        assertEquals("2026-03-09", localDay(late, almaty))
        assertEquals("2026-03-08", localDay(late, la))
    }

    @Test
    fun localDayIsZeroPadded() {
        // 2026-01-05 00:00 UTC
        assertEquals("2026-01-05", localDay(1_767_571_200_000L, utc))
    }

    @Test
    fun startOfDayIsLocalMidnight() {
        // Almaty midnight of the 8th = 2026-03-07 19:00 UTC.
        assertEquals(now - 15 * 3_600_000L, startOfLocalDayMs(now, almaty))
        assertEquals(now - 10 * 3_600_000L, startOfLocalDayMs(now, utc))
    }

    @Test
    fun startOfDayOnSpringForwardDayIsStillTheMidnightBefore() {
        // LA 2026-03-08: 02:00 PST jumps to 03:00 PDT, so the day is 23 h long. Midnight is 08:00 UTC.
        val midnight = startOfLocalDayMs(now, la)
        assertEquals(now - 2 * 3_600_000L, midnight)
        assertEquals("2026-03-08", localDay(midnight, la))
        assertEquals("2026-03-07", localDay(midnight - 1, la))
    }

    @Test
    fun startOfDayOnFallBackDayIsStillTheMidnightBefore() {
        // LA 2026-11-01: DST ends at 02:00 PDT; midnight is 07:00 UTC. 2026-11-01 20:00 UTC is 12:00 PST.
        val t = 1_793_563_200_000L
        assertEquals("2026-11-01", localDay(t, la))
        assertEquals(t - 13 * 3_600_000L, startOfLocalDayMs(t, la))
    }

    @Test
    fun startOfDayIsIdempotentAndNeverAfterNow() {
        for (tz in listOf(almaty, la, utc)) {
            val s = startOfLocalDayMs(now, tz)
            assertEquals(s, startOfLocalDayMs(s, tz))
            assertEquals(true, s <= now && now - s < 25 * 3_600_000L)
        }
    }

    @Test
    fun nextMidnightOnANormalDay() {
        // Almaty 2026-03-08 15:00 -> 2026-03-09 00:00 Almaty = 2026-03-08 19:00 UTC.
        assertEquals(now + 9 * 3_600_000L, nextLocalMidnightMs(now, almaty))
        assertEquals(now + 14 * 3_600_000L, nextLocalMidnightMs(now, utc))
        // Exactly at midnight: the next one, a full day later.
        val m = startOfLocalDayMs(now, almaty)
        assertEquals(m + 24 * 3_600_000L, nextLocalMidnightMs(m, almaty))
        assertEquals(m + 24 * 3_600_000L, nextLocalMidnightMs(m + 24 * 3_600_000L - 1, almaty))
    }

    @Test
    fun nextMidnightOnSpringForwardDay() {
        // LA 2026-03-08 03:00 PDT (23 h day); next midnight is 2026-03-09 00:00 PDT = 07:00 UTC.
        val next = nextLocalMidnightMs(now, la)
        assertEquals(now + 21 * 3_600_000L, next)
        assertEquals(23 * 3_600_000L, next - startOfLocalDayMs(now, la))
        assertEquals("2026-03-09", localDay(next, la))
        assertEquals("2026-03-08", localDay(next - 1, la))
    }

    @Test
    fun nextMidnightOnFallBackDay() {
        // LA 2026-11-01 12:00 PST (25 h day); next midnight 2026-11-02 00:00 PST = 08:00 UTC.
        val t = 1_793_563_200_000L
        val next = nextLocalMidnightMs(t, la)
        assertEquals(t + 12 * 3_600_000L, next)
        assertEquals(25 * 3_600_000L, next - startOfLocalDayMs(t, la))
        assertEquals("2026-11-02", localDay(next, la))
    }
}
