package com.aelys.notificationlog

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.provider.Settings
import android.util.Base64
import java.io.ByteArrayOutputStream
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

@TauriPlugin
class NotificationLogPlugin(private val activity: Activity) : Plugin(activity) {
    private val store get() = NotificationLogStore.get(activity)

    private fun submit(invoke: Invoke, action: (JSONObject) -> JSObject) {
        try {
            executor.execute {
                try { invoke.resolve(action(invoke.getArgs())) }
                catch (_: Exception) { invoke.reject("LOG_ERROR", "LOG_ERROR") }
            }
        } catch (_: RejectedExecutionException) { invoke.reject("LOG_BUSY", "LOG_BUSY") }
    }

    private fun accessGranted(): Boolean {
        val enabled = Settings.Secure.getString(activity.contentResolver, "enabled_notification_listeners").orEmpty()
        val me = ComponentName(activity, NotificationLogService::class.java)
        return enabled.split(':').mapNotNull { ComponentName.unflattenFromString(it) }.any { it == me }
    }

    private fun settingsJson(s: LogSettings) = JSObject().apply {
        put("hideCodes", s.hideCodes); put("keepDays", s.keepDays); put("muted", JSONArray(s.muted.sorted()))
    }

    @Command fun status(invoke: Invoke) = submit(invoke) {
        JSObject().apply { put("access", accessGranted()); put("settings", settingsJson(store.settings())) }
    }

    @Command fun openAccessSettings(invoke: Invoke) {
        activity.runOnUiThread {
            try { activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)); invoke.resolve(JSObject()) }
            catch (_: Exception) { invoke.reject("LOG_ERROR", "LOG_ERROR") }
        }
    }

    @Command fun list(invoke: Invoke) = submit(invoke) { args ->
        JSObject().apply { put("entries", store.list(args.optInt("limit", 500).coerceIn(1, 2000))) }
    }

    @Command fun remove(invoke: Invoke) = submit(invoke) { args -> store.remove(args.getLong("id")); JSObject() }

    @Command fun clear(invoke: Invoke) = submit(invoke) { store.clear(); JSObject() }

    @Command fun setSettings(invoke: Invoke) = submit(invoke) { args ->
        val muted = args.getJSONArray("muted").let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
        val keep = args.getInt("keepDays").takeIf { it in setOf(7, 30, 90) } ?: throw IllegalArgumentException("keepDays")
        val next = LogSettings(args.getBoolean("hideCodes"), keep, muted)
        store.saveSettings(next)
        settingsJson(next)
    }

    @Command fun setFinance(invoke: Invoke) = submit(invoke) { args ->
        store.setFinance(args.getLong("id"), if (args.isNull("transaction")) null else args.getString("transaction")); JSObject()
    }

    @Command fun icons(invoke: Invoke) = submit(invoke) { args ->
        val packages = args.getJSONArray("packages").let { a -> (0 until a.length()).map { a.getString(it) } }
        JSObject().apply { put("icons", JSObject().apply { packages.forEach { pkg -> iconOf(pkg)?.let { put(pkg, it) } } }) }
    }

    private fun iconOf(pkg: String): String? = iconCache.getOrPut(pkg) {
        try {
            val drawable = activity.packageManager.getApplicationIcon(pkg)
            val bitmap = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888)
            drawable.setBounds(0, 0, ICON_PX, ICON_PX)
            drawable.draw(Canvas(bitmap))
            val png = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            bitmap.recycle()
            "data:image/png;base64," + Base64.encodeToString(png, Base64.NO_WRAP)
        } catch (_: Exception) { "" }
    }.takeIf { it.isNotEmpty() }

    companion object {
        private const val ICON_PX = 96
        private val iconCache = java.util.concurrent.ConcurrentHashMap<String, String>()
        private val executor = ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, ArrayBlockingQueue(32), ThreadPoolExecutor.AbortPolicy())
    }
}
