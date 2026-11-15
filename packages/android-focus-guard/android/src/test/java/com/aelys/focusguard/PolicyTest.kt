package com.aelys.focusguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyTest {
    private val insta = GuardedApp("instagram", "Instagram", setOf("com.instagram.android"), 3600)
    private val tiktok = GuardedApp("tiktok", "TikTok", setOf("com.zhiliaoapp.musically", "com.ss.android.ugc.trill"), 1800)
    private val today = "2026-11-15"

    private fun state(
        effective: List<GuardedApp> = listOf(insta, tiktok),
        pending: List<GuardedApp>? = null,
        effectiveFrom: String? = null,
        dayUnlockedOn: String? = null,
        grants: Map<String, Long> = emptyMap(),
        grantsDay: String? = null,
    ) = GuardState(effective, pending, effectiveFrom, dayUnlockedOn, grants, grantsDay)

    @Test
    fun allowsPackagesNotInTheConfig() {
        assertNull(Policy.appFor(state(), "com.example.notes"))
        assertEquals(insta, Policy.appFor(state(), "com.instagram.android"))
        assertEquals(tiktok, Policy.appFor(state(), "com.ss.android.ugc.trill"))
    }

    @Test
    fun neverGuardsAelysOrSystemPackages() {
        for (pkg in listOf(
            "com.aelys.mobile", "com.android.systemui", "com.android.settings", "com.android.dialer",
            "com.google.android.dialer", "com.samsung.android.dialer", "com.samsung.android.incallui",
            "com.android.phone", "com.android.server.telecom", "com.google.android.permissioncontroller",
        )) {
            val mistaken = GuardedApp("x", "X", setOf(pkg, "com.instagram.android"), 60)
            assertNull(pkg, Policy.appFor(state(effective = listOf(mistaken)), pkg))
            assertEquals(mistaken, Policy.appFor(state(effective = listOf(mistaken)), "com.instagram.android"))
        }
    }

    @Test
    fun blocksOnlyAtOrOverTheLimit() {
        assertEquals(Decision.Allow, Policy.decide(insta, 3599, state(), today))
        assertEquals(Decision.Block(insta, 3600, 3600), Policy.decide(insta, 3600, state(), today))
        assertEquals(Decision.Block(insta, 4000, 3600), Policy.decide(insta, 4000, state(), today))
    }

    @Test
    fun grantAddsSecondsToTodaysLimitOnly() {
        val granted = state(grants = mapOf("instagram" to 300L), grantsDay = today)
        assertEquals(Decision.Allow, Policy.decide(insta, 3899, granted, today))
        assertEquals(Decision.Block(insta, 3900, 3600), Policy.decide(insta, 3900, granted, today))
        assertEquals(300L, Policy.secondsUntilBlock(insta, 3600, granted, today))
        val stale = state(grants = mapOf("instagram" to 300L), grantsDay = "2026-11-14")
        assertTrue(Policy.decide(insta, 3600, stale, today) is Decision.Block)
        assertEquals(0L, Policy.secondsUntilBlock(insta, 3600, stale, today))
        val other = state(grants = mapOf("tiktok" to 300L), grantsDay = today)
        assertTrue(Policy.decide(insta, 3600, other, today) is Decision.Block)
    }

    @Test
    fun dayUnlockAllowsAndOnlyForThatDate() {
        assertEquals(Decision.Allow, Policy.decide(insta, 99999, state(dayUnlockedOn = today), today))
        assertNull(Policy.secondsUntilBlock(insta, 99999, state(dayUnlockedOn = today), today))
        assertTrue(Policy.decide(insta, 99999, state(dayUnlockedOn = "2026-11-14"), today) is Decision.Block)
        assertEquals(0L, Policy.secondsUntilBlock(insta, 99999, state(dayUnlockedOn = "2026-11-14"), today))
    }

    @Test
    fun secondsUntilBlockCountsDown() {
        assertEquals(3000L, Policy.secondsUntilBlock(insta, 600, state(), today))
        assertEquals(1L, Policy.secondsUntilBlock(insta, 3599, state(), today))
        assertEquals(0L, Policy.secondsUntilBlock(insta, 3600, state(), today))
        assertEquals(0L, Policy.secondsUntilBlock(insta, 5000, state(), today))
    }

    @Test
    fun promoteAppliesPendingOnOrAfterEffectiveFrom() {
        val pending = listOf(insta.copy(limitSeconds = 600))
        val s = state(pending = pending, effectiveFrom = "2026-11-16")
        for (day in listOf("2026-11-16", "2026-11-20", "2027-01-01")) {
            val p = Policy.promote(s, day)
            assertEquals(pending, p.effective)
            assertNull(p.pending)
            assertNull(p.effectiveFrom)
            assertEquals(s.grants, p.grants)
        }
    }

    @Test
    fun promoteKeepsPendingBeforeEffectiveFrom() {
        val s = state(pending = listOf(insta.copy(limitSeconds = 600)), effectiveFrom = "2026-11-16")
        assertEquals(s, Policy.promote(s, "2026-11-15"))
        val noPending = state()
        assertEquals(noPending, Policy.promote(noPending, today))
    }
}
