package com.aelys.updateverifier

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class UpdateArchiveTest {
    @Test fun accepts_android_style_cache_alias_but_rejects_update_directory_escape() {
        val temp=Files.createTempDirectory("aelys-update-path-")
        try {
            val real=Files.createDirectory(temp.resolve("real"))
            val updates=Files.createDirectory(real.resolve("updates"))
            Files.write(updates.resolve("aelys-update.apk"),byteArrayOf(1))
            val alias=Files.createSymbolicLink(temp.resolve("alias"),real)
            assertEquals(updates.resolve("aelys-update.apk").toFile().canonicalFile,updateArchive(alias.toFile()))
            Files.delete(updates.resolve("aelys-update.apk")); Files.delete(updates)
            val outside=Files.createDirectory(temp.resolve("outside"))
            Files.write(outside.resolve("aelys-update.apk"),byteArrayOf(1))
            Files.createSymbolicLink(real.resolve("updates"),outside)
            try { updateArchive(alias.toFile()); fail("A symlink must not select an APK outside the fixed update cache") }
            catch (_: IllegalStateException) { }
        } finally { temp.toFile().deleteRecursively() }
    }
}
