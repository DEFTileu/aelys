from __future__ import annotations

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.agents.trust import build_signed_manifest, digest_file, verify_signed_manifest


def test_runtime_manifest_helper_signs_and_verifies_release_digests(tmp_path):
    runtime = tmp_path / "runtime"
    probe = tmp_path / "probe"
    runtime.write_bytes(b"runtime")
    probe.write_bytes(b"probe")
    key = Ed25519PrivateKey.from_private_bytes(bytes([3]) * 32)
    public, manifest = build_signed_manifest(digest_file(runtime), digest_file(probe), "test", key.private_bytes_raw())
    assert verify_signed_manifest(public, manifest, digest_file(runtime), digest_file(probe))
    assert not verify_signed_manifest(public, manifest, "0" * 64, digest_file(probe))
