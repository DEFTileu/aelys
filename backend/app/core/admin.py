"""Server-side owner tools. Shell access to the server is the trust anchor for these commands.

    python -m app.core.admin setup-token              # first owner on an empty server
    python -m app.core.admin setup-token --recovery   # add a device to the existing owner when all devices are lost
"""
from __future__ import annotations

import argparse
import asyncio

from . import db as database
from .device_auth import issue_setup_token


async def _issue(purpose: str) -> str:
    async with database.SessionLocal() as session:
        return await issue_setup_token(session, purpose)


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.core.admin")
    commands = parser.add_subparsers(dest="command", required=True)
    token = commands.add_parser("setup-token", help="print a one-time setup token")
    token.add_argument("--recovery", action="store_true", help="enroll a new device for the existing owner")
    args = parser.parse_args()
    if args.command == "setup-token":
        print(asyncio.run(_issue("recovery" if args.recovery else "first_owner")))


if __name__ == "__main__":
    main()
