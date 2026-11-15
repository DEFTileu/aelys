package com.aelys.focusguard

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class StateJsonTest {
    private val previous = GuardState(
        effective = DEFAULT_APPS, pending = null, effectiveFrom = null, dayUnlockedOn = null,
        grants = mapOf("instagram" to 300L), grantsDay = "2026-11-15",
    )

    private fun app(id: String = "instagram", label: Any = "Instagram", packages: List<Any> = listOf("com.instagram.android"), limit: Any = 60) =
        JSONObject().put("id", id).put("label", label).put("packages", JSONArray(packages)).put("limit_minutes", limit)

    private fun state(
        effective: List<JSONObject> = listOf(app()),
        pending: Any? = JSONObject.NULL,
        from: Any? = JSONObject.NULL,
        unlocked: Any? = JSONObject.NULL,
    ) = JSONObject().put("effective", JSONArray(effective)).put("pending", pending)
        .put("effectiveFrom", from).put("dayUnlockedOn", unlocked)

    private fun assertInvalid(json: JSONObject) {
        try {
            parseGuardStateJson(json, previous)
            fail("expected InvalidStateException for $json")
        } catch (_: InvalidStateException) {
        }
    }

    @Test
    fun validStateConvertsMinutesToSecondsAndKeepsGrants() {
        val s = parseGuardStateJson(
            state(
                effective = listOf(app(packages = listOf("com.zhiliaoapp.musically", "com.ss.android.ugc.trill"), id = "tiktok", label = "TikTok", limit = 90)),
                pending = JSONArray(listOf(app(limit = 30))),
                from = "2026-11-16",
                unlocked = "2026-11-15",
            ),
            previous,
        )
        assertEquals(listOf(GuardedApp("tiktok", "TikTok", setOf("com.zhiliaoapp.musically", "com.ss.android.ugc.trill"), 5400)), s.effective)
        assertEquals(listOf(GuardedApp("instagram", "Instagram", setOf("com.instagram.android"), 1800)), s.pending)
        assertEquals("2026-11-16", s.effectiveFrom)
        assertEquals("2026-11-15", s.dayUnlockedOn)
        assertEquals(previous.grants, s.grants)
        assertEquals(previous.grantsDay, s.grantsDay)
    }

    @Test
    fun nullPendingIsNoPendingAndEmptyPendingIsRemoveAll() {
        assertNull(parseGuardStateJson(state(pending = JSONObject.NULL), previous).pending)
        assertEquals(emptyList<GuardedApp>(), parseGuardStateJson(state(pending = JSONArray(), from = "2026-11-16"), previous).pending)
        assertEquals(emptyList<GuardedApp>(), parseGuardStateJson(state(effective = emptyList()), previous).effective)
    }

    @Test
    fun limitMustBeAWholeNumberOfMinutesInOneToADay() {
        assertEquals(60L, parseGuardStateJson(state(listOf(app(limit = 1))), previous).effective[0].limitSeconds)
        assertEquals(86_400L, parseGuardStateJson(state(listOf(app(limit = 1440))), previous).effective[0].limitSeconds)
        for (bad in listOf<Any>(0, -5, 1441, 1.5, 60.0, "60", true, JSONObject.NULL)) assertInvalid(state(listOf(app(limit = bad))))
        assertInvalid(JSONObject().put("effective", JSONArray(listOf(JSONObject().put("id", "a").put("label", "A").put("packages", JSONArray(listOf("a.b")))))))
    }

    @Test
    fun appAndPackageCountsAreBounded() {
        fun apps(n: Int) = (1..n).map { app(id = "app$it") }
        parseGuardStateJson(state(apps(30)), previous)
        assertInvalid(state(apps(31)))
        assertInvalid(state(pending = JSONArray(apps(31)), from = "2026-11-16"))
        parseGuardStateJson(state(listOf(app(packages = (1..10).map { "com.p$it" }))), previous)
        assertInvalid(state(listOf(app(packages = (1..11).map { "com.p$it" }))))
        assertInvalid(state(listOf(app(packages = emptyList()))))
    }

    @Test
    fun packageNamesUseOnlyAsciiLettersDigitsDotsUnderscores() {
        parseGuardStateJson(state(listOf(app(packages = listOf("com.Foo_1.bar")))), previous)
        parseGuardStateJson(state(listOf(app(packages = listOf("a".repeat(255))))), previous)
        for (bad in listOf<Any>("", "a".repeat(256), "com/foo", "com.foo bar", "../etc", "com.foo;", "cömfoo", 5, JSONObject.NULL)) {
            assertInvalid(state(listOf(app(packages = listOf(bad)))))
        }
    }

    @Test
    fun appIdsAreSlugsAndUnique() {
        parseGuardStateJson(state(listOf(app(id = "a-b_9"), app(id = "z".repeat(40)))), previous)
        for (bad in listOf("", "Insta", "a b", "a".repeat(41), "../x", "é")) assertInvalid(state(listOf(app(id = bad))))
        assertInvalid(state(listOf(app(id = "dup"), app(id = "dup"))))
        assertInvalid(state(listOf(app(id = "dup")), pending = JSONArray(listOf(app(id = "x"), app(id = "x"))), from = "2026-11-16"))
    }

    @Test
    fun labelIsAShortNonEmptyString() {
        parseGuardStateJson(state(listOf(app(label = "x".repeat(60)))), previous)
        for (bad in listOf<Any>("", "x".repeat(61), 7, JSONObject.NULL)) assertInvalid(state(listOf(app(label = bad))))
    }

    @Test
    fun datesMustBeRealCalendarDays() {
        parseGuardStateJson(state(from = "2028-02-29", unlocked = "2026-12-31"), previous)
        for (bad in listOf<Any>("2026-02-29", "2026-13-01", "2026-00-10", "2026-11-31", "26-11-15", "2026-1-5", "", 20261115)) {
            assertInvalid(state(from = bad))
            assertInvalid(state(unlocked = bad))
        }
    }

    @Test
    fun malformedShapesAreRejected() {
        assertInvalid(JSONObject())
        assertInvalid(JSONObject().put("effective", "x"))
        assertInvalid(JSONObject().put("effective", JSONArray(listOf("x"))))
        assertInvalid(state(pending = "x", from = "2026-11-16"))
        assertInvalid(state(pending = JSONObject()))
    }
}
