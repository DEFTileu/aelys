package com.aelys.sessionstore

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

@TauriPlugin
class SessionStorePlugin(activity: Activity) : Plugin(activity) {
    private val store = SessionStore(activity.applicationContext)
    private fun submit(invoke: Invoke, action: (JSONObject) -> JSObject) {
        try {
            executor.execute {
                try { invoke.resolve(action(invoke.getArgs())) }
                catch (_: Exception) { invoke.reject("STORE_ERROR", "STORE_ERROR") }
            }
        } catch (_: RejectedExecutionException) { invoke.reject("STORE_BUSY", "STORE_BUSY") }
    }
    @Command fun read(invoke: Invoke) = submit(invoke) { args ->
        JSObject().apply { put("record", store.read(args.getString("origin")) ?: JSONObject.NULL) }
    }
    @Command fun write(invoke: Invoke) = submit(invoke) { args ->
        store.write(args.getString("origin"), args.getString("record")); JSObject()
    }
    @Command fun delete(invoke: Invoke) = submit(invoke) { args ->
        store.delete(args.getString("origin")); JSObject()
    }
    companion object {
        private val executor = ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, ArrayBlockingQueue(32), ThreadPoolExecutor.AbortPolicy())
    }
}
