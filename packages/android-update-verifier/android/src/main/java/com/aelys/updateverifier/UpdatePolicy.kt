package com.aelys.updateverifier

internal data class ApkIdentity(val packageId: String, val version: String?, val code: Long, val signers: Set<String>, val history: Set<String>)

internal fun acceptsUpdate(installed: ApkIdentity, candidate: ApkIdentity, version: String, code: Long): Boolean {
    if (installed.packageId != "com.aelys.mobile" || candidate.packageId != installed.packageId ||
        candidate.version != version || candidate.code != code || code <= installed.code ||
        installed.signers.isEmpty() || candidate.signers.isEmpty()) return false
    if (installed.signers.size > 1 || candidate.signers.size > 1) return installed.signers == candidate.signers
    // Android's archive parser supplies the verified proof-of-rotation history.
    return candidate.signers == installed.signers || candidate.history.containsAll(installed.signers)
}
