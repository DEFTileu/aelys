from __future__ import annotations

import argparse
import asyncio

from app.core.db import SessionLocal
from app.core.export import build_owner_export, write_encrypted_export


async def main(owner_email: str, output: str) -> None:
    async with SessionLocal() as db:
        payload = await build_owner_export(db, owner_email)
    write_encrypted_export(output, payload)
    print(f"encrypted owner export written: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create an encrypted Aelys single-owner export")
    parser.add_argument("--owner-email", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    asyncio.run(main(args.owner_email, args.output))
