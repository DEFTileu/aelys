"""AI contracts on SQLite and explicitly enabled, disposable PostgreSQL databases."""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from app.core.db import Base
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


@pytest_asyncio.fixture(params=["sqlite", "postgresql"])
async def ai_test_engine(
    tmp_path: Path, request: pytest.FixtureRequest
) -> AsyncIterator[AsyncEngine]:
    if request.param == "sqlite":
        sqlite_engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/ai-contract.db")
        try:
            async with sqlite_engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            yield sqlite_engine
        finally:
            await sqlite_engine.dispose()
        return

    configured = os.environ.get("AELYS_TEST_AI_POSTGRES_ADMIN_URL")
    if not configured:
        pytest.skip(
            "Set AELYS_TEST_AI_POSTGRES_ADMIN_URL for disposable PostgreSQL AI contracts"
        )
    url = make_url(configured)
    if (
        url.drivername != "postgresql+asyncpg"
        or url.host not in {"127.0.0.1", "localhost", "::1"}
        or url.database != "postgres"
    ):
        pytest.fail(
            "AI PostgreSQL tests require an explicit loopback asyncpg admin URL to the postgres database"
        )
    name = f"aelys_ai_test_{uuid4().hex}"
    database_url = url.set(database=name)
    admin = create_async_engine(url, isolation_level="AUTOCOMMIT")
    created = False
    engine = None
    try:
        async with admin.connect() as connection:
            await connection.execute(text(f'CREATE DATABASE "{name}"'))
            created = True
        backend = Path(__file__).resolve().parents[2]
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "alembic",
            "upgrade",
            "head",
            cwd=backend,
            env={
                **os.environ,
                "AELYS_SECRET_KEY": "test-only-ai-migration-key-0123456789",
                "AELYS_PROVIDER_ENCRYPTION_KEY": "test-only-ai-migration-encryption-0123456789",
                "AELYS_DATABASE_URL": database_url.render_as_string(
                    hide_password=False
                ),
            },
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(), 30)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError(
                "Disposable AI database migrations exceeded 30 seconds"
            ) from None
        if process.returncode != 0:
            detail = output.decode(errors="replace")[-4000:]
            if url.password:
                detail = detail.replace(url.password, "[REDACTED]")
            pytest.fail(f"Disposable AI database migration failed: {detail}")
        engine = create_async_engine(database_url)
        assert engine.dialect.name == "postgresql"
        yield engine
    finally:
        try:
            if engine is not None:
                await engine.dispose()
            if created:
                async with admin.connect() as connection:
                    # Only this fixture's generated name is dropped. No FORCE:
                    # leaked application connections must fail the test visibly.
                    await connection.execute(text(f'DROP DATABASE "{name}"'))
        finally:
            await admin.dispose()
