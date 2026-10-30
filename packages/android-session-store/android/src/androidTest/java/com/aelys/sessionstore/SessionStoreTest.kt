package com.aelys.sessionstore

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
class SessionStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val directory = "aelys-session-store-instrumentation"
    private val alias = "aelys.session-store.instrumentation"
    private val origin = "https://example.test"
    private lateinit var store: SessionStore
    private fun keys() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    @Before fun setUp() {
        File(context.noBackupFilesDir, directory).deleteRecursively()
        keys().deleteEntry(alias)
        store = SessionStore(context, directory, alias)
    }
    @After fun tearDown() {
        File(context.noBackupFilesDir, directory).deleteRecursively()
        keys().deleteEntry(alias)
    }
    private fun fails(action: () -> Unit) {
        try { action(); fail("expected failure") } catch (_: Exception) { }
    }
    @Test fun encryptedRoundTripAndDelete() {
        assertNull(store.read(origin))
        store.write(origin, "synthetic-refresh-value")
        val file = File(context.noBackupFilesDir, directory).listFiles()!!.single()
        assertFalse(file.readBytes().toString(Charsets.ISO_8859_1).contains("synthetic-refresh-value"))
        val first = file.readBytes()
        assertEquals("synthetic-refresh-value", store.read(origin))
        store.write(origin, "synthetic-refresh-value")
        assertFalse(first.contentEquals(file.readBytes()))
        store.delete(origin)
        assertNull(store.read(origin))
    }
    @Test fun tamperingFailsClosed() {
        store.write(origin, "synthetic")
        val file = File(context.noBackupFilesDir, directory).listFiles()!!.single()
        val bytes = file.readBytes(); bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte(); file.writeBytes(bytes)
        fails { store.read(origin) }
    }
    @Test fun ciphertextCannotBeMovedToAnotherOrigin() {
        store.write(origin, "synthetic")
        val dir = File(context.noBackupFilesDir, directory)
        val original = dir.listFiles()!!.single()
        val other = "https://other.test"
        val name = MessageDigest.getInstance("SHA-256").digest(other.toByteArray())
            .joinToString("") { "%02x".format(it.toInt() and 255) } + ".bin"
        original.copyTo(File(dir, name))
        fails { store.read(other) }
    }
    @Test fun lostKeyFailsClosedEvenForWriteAndDelete() {
        store.write(origin, "synthetic")
        keys().deleteEntry(alias)
        fails { store.read(origin) }
        fails { store.write(origin, "replacement") }
        fails { store.delete(origin) }
    }
    @Test fun interruptedMutationMarkerFailsClosed() {
        store.write(origin, "synthetic")
        File(context.noBackupFilesDir, "$directory/.uncertain").createNewFile()
        fails { store.read(origin) }
        fails { store.write(origin, "replacement") }
        fails { store.delete(origin) }
    }
    @Test fun interruptedWriteAndOriginMismatchFailClosed() {
        store.write(origin, "synthetic")
        assertNull(store.read("https://other.test"))
        File(context.noBackupFilesDir, "$directory/.pending").writeBytes(byteArrayOf(1))
        fails { store.read(origin) }
        fails { store.delete(origin) }
    }
}
