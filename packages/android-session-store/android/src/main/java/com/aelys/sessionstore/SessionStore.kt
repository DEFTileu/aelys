package com.aelys.sessionstore

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** All callers must serialize access. A leftover temporary file is an uncertain commit. */
internal class SessionStore(context: Context, private val directoryName: String = "aelys-session-store", private val alias: String = "aelys.session-store.v1") {
    private val root = context.noBackupFilesDir
    private val dir = File(root, directoryName)
    private val temp get() = File(dir, ".pending")
    private val marker get() = File(dir, ".uncertain")

    private fun exists(file: File): Boolean = try {
        Os.lstat(file.path); true
    } catch (e: ErrnoException) {
        if (e.errno == OsConstants.ENOENT) false else throw e
    }
    private fun syncDir(file: File) {
        val fd = Os.open(file.path, OsConstants.O_RDONLY, 0)
        try { Os.fsync(fd) } finally { Os.close(fd) }
    }
    private fun validate(origin: String) {
        require(origin.length in 1..2048 && origin.all { it.code in 0x21..0x7e })
        val uri = URI(origin)
        val host = uri.host ?: throw IllegalArgumentException()
        require(uri.scheme == "https" && host == host.lowercase(Locale.ROOT))
        require(uri.rawUserInfo == null && uri.rawPath.isNullOrEmpty() && uri.rawQuery == null && uri.rawFragment == null)
        require(uri.port != 443 && uri.port in -1..65535 && uri.port != 0)
        val canonical = "https://" + host + if (uri.port == -1) "" else ":${uri.port}"
        require(origin == canonical)
    }
    private fun file(origin: String): File {
        validate(origin)
        val digest = MessageDigest.getInstance("SHA-256").digest(origin.toByteArray(Charsets.UTF_8))
        return File(dir, digest.joinToString("") { "%02x".format(it.toInt() and 255) } + ".bin")
    }
    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(alias, null)
        if (existing != null) return existing as SecretKey
        check(create)
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).setKeySize(256).build())
        return generator.generateKey()
    }
    private fun ready(create: Boolean): Boolean {
        if (!exists(dir)) {
            if (!create) return false
            check(dir.mkdir())
            syncDir(root)
            key(true)
        }
        check(dir.isDirectory && !exists(temp) && !exists(marker))
        // Validate key usability even for a missing record or a deletion.
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key(false))
            doFinal(byteArrayOf())
        }
        return true
    }
    private fun beginMutation() {
        FileOutputStream(marker).use { it.fd.sync() }
        syncDir(dir)
    }
    private fun finishMutation() {
        syncDir(dir)
        Os.remove(marker.path)
        syncDir(dir)
    }
    fun read(origin: String): String? {
        val target = file(origin)
        if (!ready(false) || !exists(target)) return null
        val bytes = target.inputStream().use { input -> input.readNBytesBounded(MAX_ENVELOPE + 1) }
        require(bytes.size in (HEADER + 16)..MAX_ENVELOPE && bytes[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(1, HEADER)))
        cipher.updateAAD(origin.toByteArray(Charsets.UTF_8))
        val plain = cipher.doFinal(bytes, HEADER, bytes.size - HEADER)
        require(plain.isNotEmpty() && plain.size <= MAX_RECORD)
        return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(plain)).toString()
    }
    fun write(origin: String, record: String) {
        val target = file(origin)
        val plain = record.toByteArray(Charsets.UTF_8)
        require(plain.isNotEmpty() && plain.size <= MAX_RECORD)
        ready(true)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(false))
        check(cipher.iv.size == 12)
        cipher.updateAAD(origin.toByteArray(Charsets.UTF_8))
        val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(plain)
        beginMutation()
        FileOutputStream(temp).use { it.write(encrypted); it.fd.sync() }
        Os.rename(temp.path, target.path)
        finishMutation()
    }
    fun delete(origin: String) {
        val target = file(origin)
        if (!ready(false)) { syncDir(root); return }
        beginMutation()
        if (exists(target)) Os.remove(target.path)
        syncDir(dir)
        check(!exists(target))
        finishMutation()
    }
    companion object {
        private const val MAX_RECORD = 65536
        private const val HEADER = 13
        private const val MAX_ENVELOPE = HEADER + MAX_RECORD + 16
        private fun java.io.InputStream.readNBytesBounded(limit: Int): ByteArray {
            val out = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            while (out.size() < limit) {
                val count = read(buffer, 0, minOf(buffer.size, limit - out.size()))
                if (count == -1) break
                out.write(buffer, 0, count)
            }
            return out.toByteArray()
        }
    }
}
