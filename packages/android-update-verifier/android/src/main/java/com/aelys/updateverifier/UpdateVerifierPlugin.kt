package com.aelys.updateverifier

import android.app.Activity
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.security.MessageDigest
import java.util.concurrent.Executors

@TauriPlugin
class UpdateVerifierPlugin(private val activity: Activity) : Plugin(activity) {
    @Command fun verify(invoke: Invoke) {
        executor.execute {
            try {
                val args=invoke.getArgs()
                // A constant app-private path: callers cannot nominate arbitrary host files.
                val apk=updateArchive(activity.cacheDir)
                val flags=if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
                val installed=activity.packageManager.getPackageInfo(activity.packageName,flags)
                val candidate=activity.packageManager.getPackageArchiveInfo(apk.path,flags) ?: error("Invalid archive")
                check(acceptsUpdate(identity(installed),identity(candidate),args.getString("version"),args.getLong("versionCode")))
                invoke.resolve()
            } catch (_: Exception) { invoke.reject("UPDATE_INVALID_APK","UPDATE_INVALID_APK") }
        }
    }
    @Suppress("DEPRECATION")
    private fun identity(info: PackageInfo): ApkIdentity {
        fun digest(bytes: ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val signers=if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        val history=if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.signingCertificateHistory else info.signatures
        val code=if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
        return ApkIdentity(info.packageName,info.versionName,code,signers?.map { digest(it.toByteArray()) }?.toSet() ?: emptySet(),history?.map { digest(it.toByteArray()) }?.toSet() ?: emptySet())
    }
    companion object { private val executor=Executors.newSingleThreadExecutor() }
}
