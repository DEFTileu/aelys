"""Real PostgreSQL tests for Telegram Guest Mode migration, claim serialization, deduplication, and Answer Trace."""
from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from app.ai.crypto import encrypt_secret
from app.core import db as database
from app.core.models import AIRun
from app.integrations import telegram_guest as guest
from app.integrations.telegram_models import TelegramGuestJob, TelegramIntegration
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from test_telegram_answer_trace import headers, signed

pytest_plugins = ("test_domain_sync_postgres",)

TOKEN = "123456:" + "g" * 30
OWNER = 424242


def _alembic_config(sync_url: str) -> Config:
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    config.set_main_option("sqlalchemy.url", sync_url)
    return config


async def test_postgres_guest_migration_upgrade_downgrade_and_constraints(monkeypatch):
    from app.core.config import get_settings

    raw = os.environ.get("AELYS_TEST_AI_POSTGRES_ADMIN_URL")
    if not raw:
        pytest.skip("explicit disposable PostgreSQL admin URL required")
    url = make_url(raw)
    assert url.host in {"localhost", "127.0.0.1"} and url.database == "postgres"
    name = "aelys_guest_mig_" + uuid4().hex
    admin = create_async_engine(url, isolation_level="AUTOCOMMIT")
    engine = None
    try:
        async with admin.connect() as conn:
            await conn.execute(text(f'CREATE DATABASE "{name}"'))
        target_async = url.set(database=name)
        target_sync = target_async.set(drivername="postgresql+psycopg")
        monkeypatch.setenv("AELYS_DATABASE_URL", target_sync.render_as_string(hide_password=False))
        get_settings.cache_clear()
        cfg = _alembic_config(target_sync.render_as_string(hide_password=False))

        await asyncio.to_thread(command.upgrade, cfg, "0063_focus_planned_seconds")
        engine = create_async_engine(target_async)
        # 0001_initial runs Base.metadata.create_all, so simulate an existing pre-0064 DB.
        async with engine.begin() as conn:
            await conn.execute(text("DROP TABLE IF EXISTS telegram_guest_jobs"))
        async with engine.connect() as conn:
            tables_before = await conn.run_sync(lambda sync: set(inspect(sync).get_table_names()))
            assert "telegram_guest_jobs" not in tables_before

        await asyncio.to_thread(command.upgrade, cfg, "0064_telegram_guest_jobs")
        async with engine.connect() as conn:
            tables_after = await conn.run_sync(lambda sync: set(inspect(sync).get_table_names()))
            assert "telegram_guest_jobs" in tables_after
            uniques = await conn.run_sync(
                lambda sync: {u["name"] for u in inspect(sync).get_unique_constraints("telegram_guest_jobs")}
            )
            assert {"uq_telegram_guest_job_update", "uq_telegram_guest_job_query"} <= uniques

        await asyncio.to_thread(command.downgrade, cfg, "0063_focus_planned_seconds")
        async with engine.connect() as conn:
            tables_down = await conn.run_sync(lambda sync: set(inspect(sync).get_table_names()))
            assert "telegram_guest_jobs" not in tables_down

        await asyncio.to_thread(command.upgrade, cfg, "head")
        async with engine.connect() as conn:
            tables_head = await conn.run_sync(lambda sync: set(inspect(sync).get_table_names()))
            assert "telegram_guest_jobs" in tables_head
    finally:
        get_settings.cache_clear()
        if engine is not None:
            await engine.dispose()
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        await admin.dispose()


async def test_postgres_parallel_guest_claim_dedup_and_trace_ownership(postgres_domain_sessions, monkeypatch):
    sessions = postgres_domain_sessions
    monkeypatch.setattr(database, "SessionLocal", sessions)
    at = datetime(2026, 11, 19, 12, tzinfo=UTC)

    async with sessions() as db:
        integration = TelegramIntegration(
            id="tg-guest-pg",
            owner_id="owner",
            bot_id=999,
            bot_username="aelys_ibot",
            bot_name="Aelys",
            business_capable=True,
            encrypted_token=encrypt_secret(TOKEN),
            owner_telegram_id=OWNER,
        )
        db.add(integration)
        await db.commit()

        payload = {
            "update_id": 501,
            "guest_message": {
                "message_id": 12,
                "guest_query_id": "pg-guest-query-1",
                "from": {"id": OWNER, "is_bot": False},
                "guest_bot_caller_user": {"id": OWNER, "is_bot": False},
                "guest_bot_caller_chat": {"id": -100777, "type": "supergroup"},
                "date": int(at.timestamp()),
                "text": "@aelys_ibot создай задачу тест aelys",
            },
        }
        assert await guest.enqueue_guest_message(db, integration, payload, at) is True
        # Duplicate update_id and duplicate guest_query_id must be ignored
        assert await guest.enqueue_guest_message(db, integration, payload, at) is False
        assert (
            await guest.enqueue_guest_message(
                db,
                integration,
                {**payload, "update_id": 502},
                at,
            )
            is False
        )
        await db.commit()

    claims = await asyncio.gather(
        guest.claim_guest_job("tg-guest-pg", at),
        guest.claim_guest_job("tg-guest-pg", at),
        guest.claim_guest_job("tg-guest-pg", at),
    )
    non_none = [c for c in claims if c is not None]
    assert len(non_none) == 1

    # Complete the run and verify Answer Trace ownership on real PostgreSQL
    async with sessions() as db:
        job = await db.get(TelegramGuestJob, non_none[0])
        assert job is not None
        run = AIRun(
            owner_id="owner",
            conversation_id=job.conversation_id,
            provider="claude",
            model="claude-pg-test",
            status="completed",
            started_at=at,
            completed_at=at,
        )
        db.add(run)
        await db.flush()
        job.run_id = run.id
        job.state = "done"
        job.delivery_status = "sent"
        job.guest_query_id = None
        await db.commit()
        run_id = run.id

    async def override_db():
        async with sessions() as session:
            yield session

    app.dependency_overrides[database.get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            ok = await client.get(
                f"/api/v1/telegram/answer-trace/{run_id}",
                headers=headers(signed(token=TOKEN, user_id=OWNER)),
            )
            assert ok.status_code == 200
            assert ok.json()["run_id"] == run_id
            assert ok.json()["model"] == "claude-pg-test"

            stranger = await client.get(
                f"/api/v1/telegram/answer-trace/{run_id}",
                headers=headers(signed(token=TOKEN, user_id=OWNER + 1)),
            )
            assert stranger.status_code == 401
    finally:
        app.dependency_overrides.pop(database.get_db, None)
