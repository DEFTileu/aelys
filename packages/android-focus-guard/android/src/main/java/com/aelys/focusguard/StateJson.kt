package com.aelys.focusguard

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** The web payload of `set_state` broke a limit or had the wrong shape; mapped to the `INVALID_STATE` error code. */
class InvalidStateException(message: String) : IllegalArgumentException(message)

private const val MAX_APPS = 30
private const val MAX_PACKAGES = 10
private const val MAX_LABEL = 60
private val PACKAGE = Regex("[A-Za-z0-9._]{1,255}")
private val APP_ID = Regex("[a-z0-9_-]{1,40}")

/**
 * Validates the `set_state` payload `{effective, pending, effectiveFrom, dayUnlockedOn}` and returns the
 * new [GuardState]: apps carry `limit_minutes` (whole number, 1..1440) converted to `limitSeconds`;
 * `grants`/`grantsDay` come from [previous] because the web layer never owns them. `pending` null or absent
 * means no pending config, while an empty array is a real "remove all apps" config. Same limits as the Rust glue.
 */
fun parseGuardStateJson(json: JSONObject, previous: GuardState): GuardState = try {
    GuardState(
        effective = apps(json.opt("effective"), "effective"),
        pending = json.opt("pending").let { if (it == null || it == JSONObject.NULL) null else apps(it, "pending") },
        effectiveFrom = date(json.opt("effectiveFrom"), "effectiveFrom"),
        dayUnlockedOn = date(json.opt("dayUnlockedOn"), "dayUnlockedOn"),
        grants = previous.grants,
        grantsDay = previous.grantsDay,
    )
} catch (e: JSONException) {
    throw InvalidStateException("malformed state")
}

private fun bad(what: String): Nothing = throw InvalidStateException("invalid $what")

private fun date(v: Any?, key: String): String? = when (v) {
    null, JSONObject.NULL -> null
    is String -> if (FocusStore.validDate(v)) v else bad(key)
    else -> bad(key)
}

private fun apps(v: Any?, key: String): List<GuardedApp> {
    val arr = v as? JSONArray ?: bad(key)
    if (arr.length() > MAX_APPS) bad("$key size")
    val out = (0 until arr.length()).map { app(arr.opt(it)) }
    if (out.map { it.id }.toSet().size != out.size) bad("$key duplicate id")
    return out
}

private fun app(v: Any?): GuardedApp {
    val o = v as? JSONObject ?: bad("app")
    val id = (o.opt("id") as? String)?.takeIf { APP_ID.matches(it) } ?: bad("id")
    val label = (o.opt("label") as? String)?.takeIf { it.codePointCount(0, it.length) in 1..MAX_LABEL } ?: bad("label")
    val pk = o.opt("packages") as? JSONArray ?: bad("packages")
    if (pk.length() !in 1..MAX_PACKAGES) bad("packages size")
    val packages = (0 until pk.length()).map { i -> (pk.opt(i) as? String)?.takeIf { PACKAGE.matches(it) } ?: bad("package") }.toSet()
    // Strictly an integer: a float or string limit is a client bug, never rounded into a looser limit.
    val minutes = when (val m = o.opt("limit_minutes")) { is Int -> m.toLong(); is Long -> m; else -> bad("limit_minutes") }
    if (minutes !in 1..1440) bad("limit_minutes")
    return GuardedApp(id, label, packages, minutes * 60)
}

/** A grant the plugin refuses; mapped to the `INVALID_GRANT` error code. */
class InvalidGrantException(message: String) : IllegalArgumentException(message)

const val MAX_GRANT_REQUEST_SECONDS = 600L

/** Rejects a stale or forged grant: [seconds] in 1..600, [appId] in the current effective config, [day] == [today]. */
fun checkGrant(state: GuardState, appId: String, seconds: Long, day: String, today: String) {
    if (seconds !in 1..MAX_GRANT_REQUEST_SECONDS) throw InvalidGrantException("seconds")
    if (state.effective.none { it.id == appId }) throw InvalidGrantException("app")
    if (day != today) throw InvalidGrantException("day")
}
