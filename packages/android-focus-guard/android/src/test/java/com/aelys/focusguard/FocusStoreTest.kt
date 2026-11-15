package com.aelys.focusguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

class FocusStoreTest {
    private class MemPrefs(val map: MutableMap<String, String> = ConcurrentHashMap()) : Prefs {
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String) { map[key] = value }
    }

    private val insta = GuardedApp("instagram", "Instagram", setOf("com.instagram.android"), 600)
    private val tiktok = GuardedApp("tiktok", "TikTok", setOf("com.zhiliaoapp.musically"), 600)
    private val today = "2026-11-15"

    private fun stored(vararg apps: GuardedApp, grants: Map<String, Long> = emptyMap(), grantsDay: String? = null) =
        GuardState(apps.toList(), null, null, null, grants, grantsDay)

    @Test
    fun defaultsAreTheThreeApps() {
        assertEquals(listOf("Instagram", "TikTok", "Pinduoduo"), DEFAULT_APPS.map { it.label })
        assertEquals(setOf("com.zhiliaoapp.musically", "com.ss.android.ugc.trill"), DEFAULT_APPS[1].packages)
        assertEquals(setOf("com.xunmeng.pinduoduo"), DEFAULT_APPS[2].packages)
        assertEquals(setOf(3600L), DEFAULT_APPS.map { it.limitSeconds }.toSet())
    }

    @Test
    fun missingOrCorruptStorageFallsBackToDefaultApps() {
        assertEquals(DEFAULT_APPS, FocusStore(MemPrefs()).load().effective)
        for (bad in listOf(
            "not json", "[]", "{}", """{"effective":"x"}""",
            """{"effective":[{"id":1,"label":"a","packages":["p"],"limitSeconds":5}]}""",
            """{"effective":[{"id":"a","label":"a","packages":"p","limitSeconds":5}]}""",
            """{"effective":[{"id":"a","label":"a","packages":["p"],"limitSeconds":"5"}]}""",
            """{"effective":[],"grants":{"a":"x"}}""",
            """{"effective":[],"grantsDay":5}""",
        )) {
            val s = FocusStore(MemPrefs(mutableMapOf("state" to bad))).load()
            assertEquals(bad, DEFAULT_APPS, s.effective)
            assertNull(bad, s.pending)
        }
    }

    @Test
    fun saveThenLoadRoundTrips() {
        val store = FocusStore(MemPrefs())
        val s = GuardState(listOf(insta), listOf(insta.copy(limitSeconds = 60)), "2026-11-16", "2026-11-15", mapOf("instagram" to 300L), "2026-11-15")
        store.save(s)
        assertEquals(s, store.load())
        val bare = GuardState(listOf(insta), null, null, null, emptyMap(), null)
        store.save(bare)
        assertEquals(bare, store.load())
    }

    @Test
    fun addGrantAddsForTodayAndResetsOnANewDay() {
        val store = FocusStore(MemPrefs())
        store.save(stored(insta, tiktok))
        store.addGrant("instagram", 300, today)
        store.addGrant("instagram", 300, today)
        store.addGrant("tiktok", 60, today)
        assertEquals(mapOf("instagram" to 600L, "tiktok" to 60L), store.load().grants)
        store.addGrant("instagram", 120, "2026-11-16")
        val s = store.load()
        assertEquals(mapOf("instagram" to 120L), s.grants)
        assertEquals("2026-11-16", s.grantsDay)
    }

    @Test
    fun addGrantIgnoresUnknownAppsAndNonPositiveSeconds() {
        val store = FocusStore(MemPrefs())
        val s0 = stored(insta, grants = mapOf("instagram" to 5L), grantsDay = "2026-11-14")
        store.save(s0)
        store.addGrant("nope", 300, today)
        store.addGrant("instagram", 0, today)
        store.addGrant("instagram", -300, today)
        assertEquals(s0, store.load())
        // never creates state out of nothing for an unknown id
        val fresh = FocusStore(MemPrefs())
        fresh.addGrant("nope", 300, today)
        assertEquals(DEFAULT_APPS, fresh.load().effective)
        assertTrue(fresh.load().grants.isEmpty())
    }

    @Test
    fun addGrantClampsTheTotalPerApp() {
        val store = FocusStore(MemPrefs())
        store.save(stored(insta))
        store.addGrant("instagram", Long.MAX_VALUE, today)
        assertEquals(86400L, store.load().grants["instagram"])
        store.addGrant("instagram", Long.MAX_VALUE, today)
        store.addGrant("instagram", 5, today)
        assertEquals(86400L, store.load().grants["instagram"])
    }

    @Test
    fun badDatesMakeTheWholeStateCorruptAndGoodOnesLoad() {
        val eff = """"effective":[{"id":"a","label":"a","packages":["p"],"limitSeconds":5}]"""
        for (field in listOf("effectiveFrom", "dayUnlockedOn", "grantsDay")) {
            for (bad in listOf("", "tomorrow", "2026-13-40", "2026-02-30", "2025-02-29", "2026-1-5", "2026-11-15 ")) {
                val s = FocusStore(MemPrefs(mutableMapOf("state" to """{$eff,"$field":"$bad"}"""))).load()
                assertEquals("$field=$bad", DEFAULT_APPS, s.effective)
            }
            val ok = FocusStore(MemPrefs(mutableMapOf("state" to """{$eff,"$field":"2028-02-29"}"""))).load()
            assertEquals("$field", listOf("a"), ok.effective.map { it.id })
        }
    }

    @Test
    fun wronglyTypedStoredValueNeverThrows() {
        val throwing = object : Prefs {
            override fun get(key: String): String? = throw ClassCastException("not a string")
            override fun put(key: String, value: String) {}
        }
        assertEquals(DEFAULT_APPS, FocusStore(throwing).load().effective)
    }

    @Test
    fun neverGuardIncludesTheOwnPackageAndAppForHonorsIt() {
        val own = "com.example.debug.aelys"
        val store = FocusStore(MemPrefs(), own)
        assertTrue(own in store.neverGuard)
        assertTrue("com.android.systemui" in store.neverGuard)
        val mistaken = GuardedApp("x", "X", setOf(own, "com.instagram.android"), 60)
        val s = stored(mistaken)
        assertNull(store.appFor(s, own))
        assertEquals(mistaken, store.appFor(s, "com.instagram.android"))
        assertEquals(mistaken, FocusStore(MemPrefs()).appFor(s, own)) // without ownPackage it is a plain app
    }

    @Test
    fun emptyPendingStaysPendingUntilItsDateThenRemovesAllApps() {
        val s = GuardState(listOf(insta), emptyList(), "2026-11-16", null, emptyMap(), null)
        val store = FocusStore(MemPrefs())
        store.save(s)
        assertEquals(s, store.load())
        assertEquals(s, Policy.promote(store.load(), today))
        val p = Policy.promote(store.load(), "2026-11-16")
        assertEquals(emptyList<GuardedApp>(), p.effective)
        assertNull(p.pending)
    }

    @Test
    fun concurrentAddGrantAndUpdateOnTwoInstancesLoseNothing() {
        val prefs = MemPrefs()
        val a = FocusStore(prefs)
        val b = FocusStore(prefs)
        a.save(stored(insta, tiktok))
        val threads = 6
        val iterations = 300
        val start = CountDownLatch(1)
        val workers = (0 until threads).map { n ->
            thread {
                val store = if (n % 2 == 0) a else b
                start.await()
                repeat(iterations) {
                    if (n < 3) store.addGrant("instagram", 1, today)
                    else store.update { s ->
                        s.copy(grants = s.grants + ("instagram" to (s.grants["instagram"] ?: 0L) + 1), grantsDay = today)
                    }
                }
            }
        }
        start.countDown()
        workers.forEach { it.join() }
        assertEquals((threads * iterations).toLong(), a.load().grants["instagram"])
        assertEquals(today, b.load().grantsDay)
    }

    @Test
    fun updateReturnsTheNewStateAndPersistsIt() {
        val store = FocusStore(MemPrefs())
        val out = store.update { it.copy(dayUnlockedOn = today) }
        assertEquals(today, out.dayUnlockedOn)
        assertEquals(out, store.load())
    }

    @Test
    fun twoThreadsTakingThePendingUnlockGetItExactlyOnce() {
        val prefs = MemPrefs()
        val stores = listOf(FocusStore(prefs), FocusStore(prefs))
        repeat(300) { round ->
            stores[0].setPendingUnlock("instagram")
            val got = AtomicInteger()
            val go = CountDownLatch(1)
            val ts = stores.map { st -> thread { go.await(); if (st.takePendingUnlock() == "instagram") got.incrementAndGet() } }
            go.countDown()
            ts.forEach { it.join() }
            assertEquals("round $round", 1, got.get())
        }
    }

    @Test
    fun takePendingUnlockReturnsTheIdOnlyOnce() {
        val store = FocusStore(MemPrefs())
        assertNull(store.takePendingUnlock())
        store.setPendingUnlock("instagram")
        assertEquals("instagram", store.takePendingUnlock())
        assertNull(store.takePendingUnlock())
        store.setPendingUnlock("tiktok")
        store.setPendingUnlock(null)
        assertNull(store.takePendingUnlock())
    }

    @Test
    fun updateWritesOnlyWhenTheStateChanged() {
        val puts = AtomicInteger()
        val prefs = object : Prefs {
            val map = ConcurrentHashMap<String, String>()
            override fun get(key: String) = map[key]
            override fun put(key: String, value: String) { puts.incrementAndGet(); map[key] = value }
        }
        val store = FocusStore(prefs)
        // Absent storage: loads the defaults; an unchanged update persists nothing.
        assertEquals(DEFAULT_APPS, store.update { it }.effective)
        assertEquals(0, puts.get())
        // Equal-but-rebuilt state is still "unchanged".
        store.update { it.copy(effective = it.effective.toList()) }
        assertEquals(0, puts.get())
        // A real change writes exactly once and is returned and persisted.
        val changed = store.update { it.copy(dayUnlockedOn = today) }
        assertEquals(today, changed.dayUnlockedOn)
        assertEquals(1, puts.get())
        assertEquals(today, store.load().dayUnlockedOn)
        // Same change again: nothing new to write.
        store.update { it.copy(dayUnlockedOn = today) }
        assertEquals(1, puts.get())
    }

    // The service's pre-check is `store.appFor(Policy.promote(load(), today), pkg)`; these pin that combination.
    @Test
    fun preCheckSeesAnAppAddedByADuePendingButNotAFutureOne() {
        val store = FocusStore(MemPrefs())
        val instaPkg = "com.instagram.android"
        val tiktokPkg = "com.zhiliaoapp.musically"
        val due = GuardState(listOf(insta), listOf(insta, tiktok), today, null, emptyMap(), null)
        assertNull(store.appFor(due, tiktokPkg)) // raw stored state: not guarded yet
        assertEquals(tiktok, store.appFor(Policy.promote(due, today), tiktokPkg))
        assertEquals(tiktok, store.appFor(Policy.promote(due.copy(effectiveFrom = "2026-11-14"), today), tiktokPkg))
        val future = due.copy(effectiveFrom = "2026-11-16")
        assertNull(store.appFor(Policy.promote(future, today), tiktokPkg))
        assertEquals(insta, store.appFor(Policy.promote(future, today), instaPkg))
    }

    @Test
    fun preCheckDropsAnAppRemovedByADuePending() {
        val store = FocusStore(MemPrefs())
        val removing = GuardState(listOf(insta, tiktok), listOf(insta), today, null, emptyMap(), null)
        assertEquals(tiktok, store.appFor(removing, "com.zhiliaoapp.musically"))
        assertNull(store.appFor(Policy.promote(removing, today), "com.zhiliaoapp.musically"))
        assertEquals(insta, store.appFor(Policy.promote(removing, today), "com.instagram.android"))
        // Not yet due: still guarded.
        assertEquals(tiktok, store.appFor(Policy.promote(removing.copy(effectiveFrom = "2026-11-16"), today), "com.zhiliaoapp.musically"))
    }

    @Test
    fun addGrantStartsFromTodaysOvershoot() {
        val store = FocusStore(MemPrefs())
        store.save(stored(insta)) // limit 600
        store.addGrant("instagram", 300, today, usedSeconds = 720)
        assertEquals(420L, store.load().grants["instagram"])
        // a larger existing grant is kept, not replaced by the overshoot
        store.addGrant("instagram", 60, today, usedSeconds = 700)
        assertEquals(480L, store.load().grants["instagram"])
    }

    @Test
    fun addGrantFromAPreviousDayIsReplacedNotSummed() {
        val store = FocusStore(MemPrefs())
        store.save(stored(insta, grants = mapOf("instagram" to 5000L), grantsDay = "2026-11-14"))
        store.addGrant("instagram", 300, today, usedSeconds = 720)
        assertEquals(mapOf("instagram" to 420L), store.load().grants)
        assertEquals(today, store.load().grantsDay)
    }

    @Test
    fun addGrantWithOvershootIsCapped() {
        val store = FocusStore(MemPrefs())
        store.save(stored(insta))
        store.addGrant("instagram", 3600, today, usedSeconds = Long.MAX_VALUE)
        assertEquals(86400L, store.load().grants["instagram"])
    }
}
