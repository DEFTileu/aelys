package com.aelys.notificationlog

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** One captured notification, as stored on this phone. */
data class Captured(val pkg: String, val app: String, val title: String, val body: String, val posted: Long, val kind: String)

data class LogSettings(val hideCodes: Boolean, val keepDays: Int, val muted: Set<String>)

/**
 * Notifications live in app-private SQLite under noBackupFilesDir, so Android backup
 * never copies them off the device. Nothing here talks to the network.
 */
class NotificationLogStore private constructor(context: Context) :
    SQLiteOpenHelper(context, File(context.noBackupFilesDir, "notification_log.db").path, null, 1) {

    private val prefs = context.getSharedPreferences("aelys_notification_log", Context.MODE_PRIVATE)

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pkg TEXT NOT NULL, app TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
                posted INTEGER NOT NULL, kind TEXT NOT NULL, finance_tx TEXT,
                sig TEXT NOT NULL UNIQUE)"""
        )
        db.execSQL("CREATE INDEX entries_posted ON entries(posted DESC)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun settings() = LogSettings(
        prefs.getBoolean("hide_codes", true),
        prefs.getInt("keep_days", 30),
        prefs.getStringSet("muted", emptySet())!!.toSet(),
    )

    fun saveSettings(s: LogSettings) {
        prefs.edit().putBoolean("hide_codes", s.hideCodes).putInt("keep_days", s.keepDays).putStringSet("muted", s.muted).apply()
        prune(s.keepDays)
    }

    /** Stores a notification once; repeated posts of the same text (progress updates, re-alerts) are ignored. */
    @Synchronized
    fun insert(c: Captured) {
        val sig = sha256("${c.pkg}\u0000${c.title}\u0000${c.body}\u0000${c.posted / 60_000}")
        writableDatabase.insertWithOnConflict("entries", null, ContentValues().apply {
            put("pkg", c.pkg); put("app", c.app); put("title", c.title); put("body", c.body)
            put("posted", c.posted); put("kind", c.kind); put("sig", sig)
        }, SQLiteDatabase.CONFLICT_IGNORE)
        prune(settings().keepDays)
    }

    @Synchronized
    fun list(limit: Int): JSONArray {
        val out = JSONArray()
        readableDatabase.query("entries", arrayOf("id", "pkg", "app", "title", "body", "posted", "kind", "finance_tx"), null, null, null, null, "posted DESC, id DESC", limit.toString()).use { c ->
            while (c.moveToNext()) out.put(JSONObject().apply {
                put("id", c.getLong(0)); put("pkg", c.getString(1)); put("app", c.getString(2)); put("title", c.getString(3))
                put("body", c.getString(4)); put("posted", c.getLong(5)); put("kind", c.getString(6))
                put("financeTx", if (c.isNull(7)) JSONObject.NULL else c.getString(7))
            })
        }
        return out
    }

    @Synchronized fun remove(id: Long) { writableDatabase.delete("entries", "id = ?", arrayOf(id.toString())) }
    @Synchronized fun clear() { writableDatabase.delete("entries", null, null) }
    @Synchronized fun setFinance(id: Long, tx: String?) {
        writableDatabase.update("entries", ContentValues().apply { if (tx == null) putNull("finance_tx") else put("finance_tx", tx) }, "id = ?", arrayOf(id.toString()))
    }

    private fun prune(keepDays: Int) {
        val cutoff = System.currentTimeMillis() - keepDays * 86_400_000L
        writableDatabase.delete("entries", "posted < ?", arrayOf(cutoff.toString()))
    }

    private fun sha256(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    companion object {
        @Volatile private var instance: NotificationLogStore? = null
        fun get(context: Context) = instance ?: synchronized(this) { instance ?: NotificationLogStore(context.applicationContext).also { instance = it } }

        private val CODE_WORDS = Regex("(?i)(code|код|otp|парол|password|passcode|verification|подтвержд|құпия|kod)")
        private val CODE_DIGITS = Regex("(?<!\\d)\\d{4,8}(?!\\d)")
        /** A one-time code: a code word plus a 4–8 digit number. */
        fun isOneTimeCode(title: String, body: String) = CODE_WORDS.containsMatchIn("$title $body") && CODE_DIGITS.containsMatchIn(body)
    }
}
