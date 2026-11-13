package com.aelys.updateverifier

import java.io.File

internal fun updateArchive(cache: File): File {
    // Android may alias the cache root through /data/user/0 or /data/data.
    val apk=File(cache.canonicalFile,"updates/aelys-update.apk")
    check(apk.isFile && apk.absoluteFile == apk.canonicalFile)
    return apk
}
