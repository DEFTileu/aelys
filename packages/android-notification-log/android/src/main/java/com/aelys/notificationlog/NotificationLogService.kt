package com.aelys.notificationlog

import android.app.Notification
import android.content.pm.PackageManager
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.util.concurrent.Executors

/** Bound by Android once the user turns on notification access for Aelys. */
class NotificationLogService : NotificationListenerService() {
    private val io = Executors.newSingleThreadExecutor()

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        val n = sbn.notification
        // Group summaries repeat their children; ongoing ones are media players, downloads, navigation.
        if (n.flags and (Notification.FLAG_GROUP_SUMMARY or Notification.FLAG_ONGOING_EVENT) != 0) return
        val extras = n.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val body = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString()?.trim().orEmpty()
        if (title.isEmpty() && body.isEmpty()) return
        val pkg = sbn.packageName
        val posted = sbn.postTime
        io.execute {
            val store = NotificationLogStore.get(this)
            val settings = store.settings()
            if (pkg in settings.muted) return@execute
            val code = NotificationLogStore.isOneTimeCode(title, body)
            // With "Hide one-time codes" on, the code text is never written to disk.
            val saved = if (code && settings.hideCodes) "" else body
            store.insert(Captured(pkg, label(pkg), title.take(500), saved.take(4000), posted, if (code) "code" else "note"))
        }
    }

    private fun label(pkg: String): String = try {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    } catch (_: PackageManager.NameNotFoundException) {
        pkg
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }
}
