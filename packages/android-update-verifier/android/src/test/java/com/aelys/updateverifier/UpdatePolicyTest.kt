package com.aelys.updateverifier

import org.junit.Assert.*
import org.junit.Test

class UpdatePolicyTest {
    private val installed = ApkIdentity("com.aelys.mobile", "0.1.0", 1000, setOf("old"), setOf("old"))
    private val valid = ApkIdentity("com.aelys.mobile", "0.2.0", 2000, setOf("old"), setOf("old"))
    @Test fun accepts_matching_newer_apk_and_verified_signing_rotation() {
        assertTrue(acceptsUpdate(installed, valid, "0.2.0", 2000))
        assertTrue(acceptsUpdate(installed, valid.copy(signers=setOf("new"), history=setOf("old", "new")), "0.2.0", 2000))
    }
    @Test fun rejects_other_apps_wrong_versions_downgrades_or_signers() {
        for (candidate in listOf(valid.copy(packageId="com.other.app"), valid.copy(version="0.3.0"), valid.copy(code=1000), valid.copy(signers=setOf("evil"),history=setOf("evil")), valid.copy(signers=emptySet(),history=emptySet()), valid.copy(signers=setOf("old","other")))) {
            assertFalse(acceptsUpdate(installed,candidate,"0.2.0",2000))
        }
        assertFalse(acceptsUpdate(installed,valid,"0.2.0",2001))
    }
    @Test fun multisigner_apps_require_exact_signer_set() {
        val multi=installed.copy(signers=setOf("a","b"),history=emptySet())
        assertTrue(acceptsUpdate(multi,valid.copy(signers=setOf("a","b")),"0.2.0",2000))
        assertFalse(acceptsUpdate(multi,valid.copy(signers=setOf("a"),history=setOf("a","b")),"0.2.0",2000))
    }
}
