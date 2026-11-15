package com.aelys.focusguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FocusStoreTest {
    private class MemPrefs(val map: MutableMap<String, String> = HashMap()) : Prefs {
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String) { map[key] = value }
    }

    private val insta = GuardedApp("instagram", "Instagram", setOf("com.instagram.android"), 600)

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
        store.save(GuardState(listOf(insta), null, null, null, emptyMap(), null))
        store.addGrant("instagram", 300, "2026-11-15")
        store.addGrant("instagram", 300, "2026-11-15")
        store.addGrant("tiktok", 60, "2026-11-15")
        assertEquals(mapOf("instagram" to 600L, "tiktok" to 60L), store.load().grants)
        store.addGrant("instagram", 120, "2026-11-16")
        val s = store.load()
        assertEquals(mapOf("instagram" to 120L), s.grants)
        assertEquals("2026-11-16", s.grantsDay)
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
}
