from __future__ import annotations

import argparse
import asyncio

from app.core.db import SessionLocal
from app.core.export import read_encrypted_export, restore_owner_export


async def main(owner_email: str, source: str) -> None:
    payload = read_encrypted_export(source)
    async with SessionLocal() as db:
        count = await restore_owner_export(db, owner_email, payload)
    print(f"restored {count} non-secret owner records")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Restore an encrypted Aelys single-owner export")
    parser.add_argument("--owner-email", required=True)
    parser.add_argument("--source", required=True)
    args = parser.parse_args()
    asyncio.run(main(args.owner_email, args.source))
