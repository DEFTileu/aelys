package com.aelys.focusguard

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import java.util.TimeZone

/**
 * Learns which app is in front from window-state changes (no screen content, see the config xml) and
 * shows [BlockActivity] when a guarded app is over its limit. Everything runs on the main thread.
 *
 * shortcut: the usage query and the store write (a `commit()`) run on the main thread per guarded-app
 * window event; fine for a day of events, move them to a worker if jank shows up on the device.
 */
class FocusAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private var wake: Runnable? = null
    /** Last package that really came forward; null until the first event. */
    private var currentPkg: String? = null
    private var receiverRegistered = false

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> cancelWake()
                // The app under the lock screen may not emit a window event on unlock, so re-check it.
                Intent.ACTION_USER_PRESENT -> currentPkg?.let { safeCheck(it) }
            }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        registerReceiver(screenReceiver, filter)
        receiverRegistered = true
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        try {
            if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
            val pkg = event.packageName?.toString() ?: return
            // The keyboard and system UI (shade, volume) draw windows over the app without leaving it.
            if (pkg == "com.android.systemui" || pkg == inputMethodPackage()) return
            currentPkg = pkg
            evaluate(pkg)
        } catch (e: Exception) {
            Log.e(TAG, "event handling failed", e)
        }
    }

    override fun onInterrupt() = cancelWake()

    override fun onUnbind(intent: Intent?): Boolean {
        shutDown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        shutDown()
        super.onDestroy()
    }

    private fun shutDown() {
        cancelWake()
        if (receiverRegistered) {
            receiverRegistered = false
            try {
                unregisterReceiver(screenReceiver)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "receiver was not registered", e)
            }
        }
    }

    private fun safeCheck(pkg: String) {
        try {
            evaluate(pkg)
        } catch (e: Exception) {
            Log.e(TAG, "check failed for $pkg", e)
        }
    }

    /**
     * Decides for [pkg] now: blocks it, or schedules the moment its time runs out. A non-guarded package
     * costs one state read and nothing else. A guarded one also costs a usage query, and a store write
     * only when a pending config is actually promoted.
     */
    private fun evaluate(pkg: String) {
        cancelWake()
        val store = FocusStore.of(this)
        val tz = TimeZone.getDefault()
        val now = System.currentTimeMillis()
        val today = localDay(now, tz)
        // Not guarded: return before any write (this runs for every window event of every app).
        if (store.appFor(store.load(), pkg) == null) return
        val state = store.update { Policy.promote(it, today) }
        // Promotion can change the effective set, so resolve the app again from the promoted state.
        val app = store.appFor(state, pkg) ?: return
        val from = startOfLocalDayMs(now, tz)
        val used = UsageMeter.foregroundSeconds(readEvents(this, from, now), app.packages, from, now)
        when (val d = Policy.decide(app, used, state, today)) {
            is Decision.Block -> startActivity(
                Intent(this, BlockActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
                    .putExtra(BlockActivity.EXTRA_APP_ID, d.app.id)
                    .putExtra(BlockActivity.EXTRA_USED, d.usedSeconds)
                    .putExtra(BlockActivity.EXTRA_LIMIT, d.limitSeconds),
            )
            Decision.Allow -> Policy.secondsUntilBlock(app, used, state, today)?.let { schedule(pkg, it) }
        }
    }

    /** Re-checks [pkg] when its time should be up, if it is still the foreground package then. A short miss just re-schedules. */
    private fun schedule(pkg: String, seconds: Long) {
        val r = Runnable {
            wake = null
            if (currentPkg == pkg) safeCheck(pkg)
        }
        wake = r
        handler.postDelayed(r, maxOf(seconds, 1L) * 1000)
    }

    private fun cancelWake() {
        wake?.let { handler.removeCallbacks(it) }
        wake = null
    }

    private fun inputMethodPackage(): String? =
        Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)?.substringBefore('/')

    private companion object {
        const val TAG = "FocusGuard"
    }
}
