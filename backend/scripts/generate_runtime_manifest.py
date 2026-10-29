#!/usr/bin/env python3
"""Create the public signed runtime trust values without printing the private key."""

from __future__ import annotations

import argparse
import base64
import os
import secrets

from app.agents.trust import build_signed_manifest, digest_file


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--probe", required=True)
    parser.add_argument("--manifest-id", default=None)
    args = parser.parse_args()
    configured = os.environ.get("AELYS_RUNTIME_TRUST_PRIVATE_KEY")
    private_key = base64.urlsafe_b64decode(configured + "=" * (-len(configured) % 4)) if configured else secrets.token_bytes(32)
    public_key, manifest = build_signed_manifest(
        digest_file(args.runtime), digest_file(args.probe), args.manifest_id or "aelys-runtime-release", private_key
    )
    print(f"AELYS_RUNTIME_TRUST_PUBLIC_KEY={public_key}")
    print(f"AELYS_RUNTIME_TRUST_MANIFEST={manifest}")
    if not configured:
        print("# Generated a new private key for this invocation; store it outside the repository.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
