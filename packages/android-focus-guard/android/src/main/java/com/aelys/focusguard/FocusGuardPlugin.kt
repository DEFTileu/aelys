package com.aelys.focusguard

import android.app.Activity
import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Commands of the web UI for the on-device guard. The Rust glue validates first; everything is checked
 * again here because this is the boundary to the enforcement state. Work runs off the main thread.
 */
@TauriPlugin
class FocusGuardPlugin(private val activity: Activity) : Plugin(activity) {
    private val store get() = FocusStore.of(activity)

    private fun submit(invoke: Invoke, action: (JSONObject) -> JSObject) {
        try {
            executor.execute {
                try { invoke.resolve(action(invoke.getArgs())) }
                catch (_: InvalidStateException) { invoke.reject("INVALID_STATE", "INVALID_STATE") }
                catch (_: InvalidGrantException) { invoke.reject("INVALID_GRANT", "INVALID_GRANT") }
                catch (_: Exception) { invoke.reject("FOCUS_ERROR", "FOCUS_ERROR") }
            }
        } catch (_: RejectedExecutionException) { invoke.reject("FOCUS_BUSY", "FOCUS_BUSY") }
    }

    @Suppress("DEPRECATION") // checkOpNoThrow is the only call below API 29; it still works above
    private fun usageAccessGranted(): Boolean {
        val ops = activity.getSystemService(Activity.APP_OPS_SERVICE) as AppOpsManager
        val mode = ops.checkOpNoThrow("android:get_usage_stats", Process.myUid(), activity.packageName)
        // MODE_DEFAULT: the op follows the manifest permission, which the Settings toggle grants.
        return mode == AppOpsManager.MODE_ALLOWED ||
            (mode == AppOpsManager.MODE_DEFAULT &&
                activity.checkCallingOrSelfPermission("android.permission.PACKAGE_USAGE_STATS") == PackageManager.PERMISSION_GRANTED)
    }

    private fun accessibilityGranted(): Boolean {
        val enabled = Settings.Secure.getString(activity.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        val me = ComponentName(activity, FocusAccessibilityService::class.java)
        return enabled.split(':').mapNotNull { ComponentName.unflattenFromString(it) }.any { it == me }
    }

    @Command fun status(invoke: Invoke) = submit(invoke) {
        JSObject().apply { put("usageAccess", usageAccessGranted()); put("accessibility", accessibilityGranted()) }
    }

    @Command fun openSettings(invoke: Invoke) {
        val intent = when (invoke.getArgs().opt("target")) {
            "usage" -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "app" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
            else -> return invoke.reject("INVALID_TARGET", "INVALID_TARGET")
        }
        activity.runOnUiThread {
            try { activity.startActivity(intent); invoke.resolve(JSObject()) }
            catch (_: Exception) { invoke.reject("FOCUS_ERROR", "FOCUS_ERROR") }
        }
    }

    /** Replaces the web-owned part of the state; `grants` stay. Parse, promote and save are one atomic update. */
    @Command fun setState(invoke: Invoke) = submit(invoke) { args ->
        store.update { Policy.promote(parseGuardStateJson(args, it), localDay(System.currentTimeMillis())) }
        JSObject()
    }

    /** Today's usage per guarded app. Without usage access (or on a read failure) used is 0; `status` says why. */
    @Command fun usage(invoke: Invoke) = submit(invoke) {
        val now = System.currentTimeMillis()
        val today = localDay(now)
        val state = Policy.promote(store.load(), today)
        val start = startOfLocalDayMs(now)
        val events = if (usageAccessGranted()) {
            try { readEvents(activity, start, now) } catch (_: Exception) { emptyList() }
        } else emptyList()
        val perApp = JSObject()
        for (app in state.effective) {
            perApp.put(app.id, JSObject().apply {
                put("usedSeconds", UsageMeter.foregroundSeconds(events, app.packages, start, now))
                put("limitSeconds", app.limitSeconds)
                put("grantedSeconds", if (state.grantsDay == today) state.grants[app.id] ?: 0L else 0L)
            })
        }
        JSObject().apply { put("usage", perApp) }
    }

    @Command fun applyGrant(invoke: Invoke) = submit(invoke) { args ->
        val seconds = when (val v = args.opt("seconds")) { is Int -> v.toLong(); is Long -> v; else -> throw InvalidGrantException("seconds") }
        val appId = args.opt("appId") as? String ?: throw InvalidGrantException("app")
        val day = args.opt("day") as? String ?: throw InvalidGrantException("day")
        val today = localDay(System.currentTimeMillis())
        // Promote first so an app that a due pending config just added can be granted.
        checkGrant(store.update { Policy.promote(it, today) }, appId, seconds, day, today)
        store.addGrant(appId, seconds, today)
        JSObject()
    }

    @Command fun installedApps(invoke: Invoke) = submit(invoke) {
        val pm = activity.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(launcher, 0)
            .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
            .filter { it.first != activity.packageName }
            .distinctBy { it.first }
            .sortedWith(compareBy({ it.second.lowercase() }, { it.first }))
        JSObject().apply {
            put("apps", JSONArray().also { arr -> apps.forEach { (pkg, label) -> arr.put(JSONObject().put("pkg", pkg).put("label", label)) } })
        }
    }

    @Command fun takePendingUnlock(invoke: Invoke) = submit(invoke) {
        JSObject().apply { put("appId", store.takePendingUnlock() ?: JSONObject.NULL) }
    }

    companion object {
        private val executor = ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, ArrayBlockingQueue(32), ThreadPoolExecutor.AbortPolicy())
    }
}
