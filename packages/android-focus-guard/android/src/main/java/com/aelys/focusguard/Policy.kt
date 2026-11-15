package com.aelys.focusguard

data class GuardedApp(val id: String, val label: String, val packages: Set<String>, val limitSeconds: Long)

/** Dates are local `YYYY-MM-DD`; [grants] maps app id to granted seconds for [grantsDay]. */
data class GuardState(
    val effective: List<GuardedApp>,
    val pending: List<GuardedApp>?,
    val effectiveFrom: String?,
    val dayUnlockedOn: String?,
    val grants: Map<String, Long>,
    val grantsDay: String?,
)

sealed interface Decision {
    object Allow : Decision
    data class Block(val app: GuardedApp, val usedSeconds: Long, val limitSeconds: Long) : Decision
}

/** Never blocked, even when listed in the config by mistake: Aelys itself, system UI, calls, permission dialogs. */
val NEVER_GUARD: Set<String> = setOf(
    "com.aelys.mobile",
    "com.android.systemui",
    "com.android.settings",
    "com.android.dialer",
    "com.google.android.dialer",
    "com.samsung.android.dialer",
    "com.samsung.android.incallui",
    "com.android.phone",
    "com.android.server.telecom",
    "com.google.android.permissioncontroller",
)

val DEFAULT_APPS: List<GuardedApp> = listOf(
    GuardedApp("instagram", "Instagram", setOf("com.instagram.android"), 3600),
    GuardedApp("tiktok", "TikTok", setOf("com.zhiliaoapp.musically", "com.ss.android.ugc.trill"), 3600),
    GuardedApp("pinduoduo", "Pinduoduo", setOf("com.xunmeng.pinduoduo"), 3600),
)

object Policy {
    /** Applies [GuardState.pending] once [today] reaches [GuardState.effectiveFrom] (ISO dates compare as strings). */
    fun promote(state: GuardState, today: String): GuardState {
        val pending = state.pending ?: return state
        val from = state.effectiveFrom ?: return state
        if (today < from) return state
        return state.copy(effective = pending, pending = null, effectiveFrom = null)
    }

    /** The guarded app owning [pkg], or null. [extraNeverGuard] adds runtime packages (e.g. Aelys's own id). */
    fun appFor(state: GuardState, pkg: String, extraNeverGuard: Set<String> = emptySet()): GuardedApp? {
        if (pkg in NEVER_GUARD || pkg in extraNeverGuard) return null
        return state.effective.firstOrNull { pkg in it.packages }
    }

    /** A [Decision.Block] carries today's whole allowance (limit + today's grant), which the block screen shows. */
    fun decide(app: GuardedApp, usedSeconds: Long, state: GuardState, today: String): Decision {
        val left = secondsUntilBlock(app, usedSeconds, state, today) ?: return Decision.Allow
        return if (left > 0) Decision.Allow else Decision.Block(app, usedSeconds, app.limitSeconds + grantToday(app, state, today))
    }

    /** Seconds of use left today, 0 once blocked, null when the whole day is unlocked. */
    fun secondsUntilBlock(app: GuardedApp, usedSeconds: Long, state: GuardState, today: String): Long? {
        if (state.dayUnlockedOn == today) return null
        return (app.limitSeconds + grantToday(app, state, today) - usedSeconds).coerceAtLeast(0)
    }

    private fun grantToday(app: GuardedApp, state: GuardState, today: String): Long =
        if (state.grantsDay == today) state.grants[app.id] ?: 0L else 0L

    /**
     * Today's grant after granting [seconds] more. It starts from the overshoot (`used - limit`), so a grant
     * bought while already over the limit opens the app for exactly [seconds]; a larger existing grant is kept.
     * Every term is clamped to [0, MAX_GRANT_SECONDS] first, so the sum cannot overflow.
     */
    fun grantAfter(app: GuardedApp, usedSeconds: Long, existingGrantSeconds: Long, seconds: Long): Long {
        val cap = FocusStore.MAX_GRANT_SECONDS
        val overshoot = (usedSeconds.coerceAtLeast(0) - app.limitSeconds.coerceAtLeast(0)).coerceIn(0, cap)
        val base = maxOf(existingGrantSeconds.coerceIn(0, cap), overshoot)
        return (base + seconds.coerceIn(0, cap)).coerceAtMost(cap)
    }
}
