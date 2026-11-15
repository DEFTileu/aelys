package com.aelys.focusguard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

interface Prefs {
    fun get(key: String): String?
    fun put(key: String, value: String)
}

/**
 * Local guard state. Every instance (and `FocusStore.of` makes a new one per call) shares one
 * process-wide lock. All load-modify-save must go through [update] or [addGrant]; a bare
 * `save(load()...)` can overwrite a concurrent change, e.g. a paid grant.
 */
class FocusStore(private val prefs: Prefs, ownPackage: String? = null) {
    /** Packages never guarded: the constant set plus Aelys's own runtime package id. */
    val neverGuard: Set<String> = if (ownPackage == null) NEVER_GUARD else NEVER_GUARD + ownPackage

    /** [Policy.appFor] with [neverGuard], so callers cannot forget the own-package exclusion. */
    fun appFor(state: GuardState, pkg: String): GuardedApp? = Policy.appFor(state, pkg, neverGuard)

    /** Missing or corrupt storage yields the defaults, so a broken state is never looser than them. */
    fun load(): GuardState = synchronized(LOCK) {
        try {
            prefs.get(STATE)?.let { parse(JSONObject(it)) } ?: DEFAULT_STATE
        } catch (e: Exception) {
            DEFAULT_STATE
        }
    }

    fun save(state: GuardState) = synchronized(LOCK) { prefs.put(STATE, toJson(state).toString()) }

    /** Atomic load -> [transform] -> save; returns the new state. Saves only if it differs from the loaded one. */
    fun update(transform: (GuardState) -> GuardState): GuardState = synchronized(LOCK) {
        val old = load()
        transform(old).also { if (it != old) save(it) }
    }

    /**
     * Adds [seconds] to [appId]'s grant for [today] (a new day starts a fresh grant map). Ignores non-positive
     * seconds and ids not in `effective`; each app's total is capped at [MAX_GRANT_SECONDS] so limit + grant cannot overflow.
     */
    fun addGrant(appId: String, seconds: Long, today: String) {
        if (seconds <= 0) return
        update { s ->
            if (s.effective.none { it.id == appId }) return@update s
            val base = if (s.grantsDay == today) s.grants else emptyMap()
            val total = ((base[appId] ?: 0L) + seconds.coerceAtMost(MAX_GRANT_SECONDS)).coerceAtMost(MAX_GRANT_SECONDS)
            s.copy(grants = base + (appId to total), grantsDay = today)
        }
    }

    fun setPendingUnlock(appId: String?) = synchronized(LOCK) { prefs.put(PENDING_UNLOCK, appId ?: "") }

    fun takePendingUnlock(): String? = synchronized(LOCK) {
        val id = prefs.get(PENDING_UNLOCK)?.takeIf { it.isNotEmpty() }
        if (id != null) setPendingUnlock(null)
        id
    }

    companion object {
        /** One lock for the whole process: `of(context)` hands out a new instance per call. */
        private val LOCK = Any()
        private const val STATE = "state"
        private const val PENDING_UNLOCK = "pending_unlock"
        const val MAX_GRANT_SECONDS = 86_400L
        private val DEFAULT_STATE = GuardState(DEFAULT_APPS, null, null, null, emptyMap(), null)

        fun of(context: Context): FocusStore {
            val sp = context.getSharedPreferences("aelys_focus_guard", Context.MODE_PRIVATE)
            val prefs = object : Prefs {
                override fun get(key: String): String? = sp.getString(key, null)
                // commit(), not apply(): a write lost on process kill would be a lost paid grant.
                override fun put(key: String, value: String) { sp.edit().putString(key, value).commit() }
            }
            return FocusStore(prefs, context.packageName)
        }

        private fun toJson(s: GuardState) = JSONObject().apply {
            put("effective", appsToJson(s.effective))
            put("pending", s.pending?.let { appsToJson(it) } ?: JSONObject.NULL)
            put("effectiveFrom", s.effectiveFrom ?: JSONObject.NULL)
            put("dayUnlockedOn", s.dayUnlockedOn ?: JSONObject.NULL)
            put("grants", JSONObject().also { o -> s.grants.forEach { (k, v) -> o.put(k, v) } })
            put("grantsDay", s.grantsDay ?: JSONObject.NULL)
        }

        private fun appsToJson(apps: List<GuardedApp>) = JSONArray().also { arr ->
            apps.forEach { a ->
                arr.put(JSONObject().put("id", a.id).put("label", a.label)
                    .put("packages", JSONArray(a.packages.toList())).put("limitSeconds", a.limitSeconds))
            }
        }

        // Strict parsing: any wrong type throws, and load() treats that as corrupt.
        private fun parse(o: JSONObject) = GuardState(
            effective = apps(o.get("effective")),
            pending = o.opt("pending").let { if (it == null || it == JSONObject.NULL) null else apps(it) },
            effectiveFrom = optDate(o, "effectiveFrom"),
            dayUnlockedOn = optDate(o, "dayUnlockedOn"),
            grants = (o.opt("grants") ?: JSONObject()).let { g ->
                g as? JSONObject ?: throw IllegalArgumentException("grants")
                g.keys().asSequence().associateWith { k -> (g.get(k) as? Number ?: throw IllegalArgumentException(k)).toLong() }
            },
            grantsDay = optDate(o, "grantsDay"),
        )

        private val DATE = Regex("""\d{4}-\d{2}-\d{2}""")

        // Hand-rolled calendar check: java.time needs API 26 and minSdk is 24.
        internal fun validDate(s: String): Boolean {
            if (!DATE.matches(s)) return false
            val y = s.substring(0, 4).toInt()
            val m = s.substring(5, 7).toInt()
            val d = s.substring(8, 10).toInt()
            val leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
            val days = intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
            return m in 1..12 && d in 1..days[m - 1]
        }

        private fun optDate(o: JSONObject, key: String): String? = when (val v = o.opt(key)) {
            null, JSONObject.NULL -> null
            is String -> if (validDate(v)) v else throw IllegalArgumentException(key)
            else -> throw IllegalArgumentException(key)
        }

        private fun apps(v: Any): List<GuardedApp> {
            val arr = v as? JSONArray ?: throw IllegalArgumentException("apps")
            return (0 until arr.length()).map { i ->
                val a = arr.get(i) as? JSONObject ?: throw IllegalArgumentException("app")
                val pk = a.get("packages") as? JSONArray ?: throw IllegalArgumentException("packages")
                GuardedApp(
                    a.get("id") as? String ?: throw IllegalArgumentException("id"),
                    a.get("label") as? String ?: throw IllegalArgumentException("label"),
                    (0 until pk.length()).map { pk.get(it) as? String ?: throw IllegalArgumentException("pkg") }.toSet(),
                    (a.get("limitSeconds") as? Number ?: throw IllegalArgumentException("limit")).toLong(),
                )
            }
        }
    }
}
