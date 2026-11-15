package com.aelys.focusguard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

interface Prefs {
    fun get(key: String): String?
    fun put(key: String, value: String)
}

class FocusStore(private val prefs: Prefs, ownPackage: String? = null) {
    /** Packages never guarded: the constant set plus Aelys's own runtime package id. */
    val neverGuard: Set<String> = if (ownPackage == null) NEVER_GUARD else NEVER_GUARD + ownPackage

    /** Missing or corrupt storage yields the defaults, so a broken state is never looser than them. */
    fun load(): GuardState {
        val raw = prefs.get(STATE) ?: return DEFAULT_STATE
        return try { parse(JSONObject(raw)) } catch (e: Exception) { DEFAULT_STATE }
    }

    fun save(state: GuardState) = prefs.put(STATE, toJson(state).toString())

    fun addGrant(appId: String, seconds: Long, today: String) {
        val s = load()
        val base = if (s.grantsDay == today) s.grants else emptyMap()
        save(s.copy(grants = base + (appId to (base[appId] ?: 0L) + seconds), grantsDay = today))
    }

    fun setPendingUnlock(appId: String?) = prefs.put(PENDING_UNLOCK, appId ?: "")

    fun takePendingUnlock(): String? {
        val id = prefs.get(PENDING_UNLOCK)?.takeIf { it.isNotEmpty() }
        if (id != null) setPendingUnlock(null)
        return id
    }

    companion object {
        private const val STATE = "state"
        private const val PENDING_UNLOCK = "pending_unlock"
        private val DEFAULT_STATE = GuardState(DEFAULT_APPS, null, null, null, emptyMap(), null)

        fun of(context: Context): FocusStore {
            val sp = context.getSharedPreferences("aelys_focus_guard", Context.MODE_PRIVATE)
            val prefs = object : Prefs {
                override fun get(key: String): String? = sp.getString(key, null)
                override fun put(key: String, value: String) = sp.edit().putString(key, value).apply()
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
            effectiveFrom = optString(o, "effectiveFrom"),
            dayUnlockedOn = optString(o, "dayUnlockedOn"),
            grants = (o.opt("grants") ?: JSONObject()).let { g ->
                g as? JSONObject ?: throw IllegalArgumentException("grants")
                g.keys().asSequence().associateWith { k -> (g.get(k) as? Number ?: throw IllegalArgumentException(k)).toLong() }
            },
            grantsDay = optString(o, "grantsDay"),
        )

        private fun optString(o: JSONObject, key: String): String? = when (val v = o.opt(key)) {
            null, JSONObject.NULL -> null
            is String -> v
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
