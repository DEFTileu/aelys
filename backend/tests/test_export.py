from __future__ import annotations

import base64

import pytest
from app.core import db
from app.core.db import Base
from app.core.export import (
    build_owner_export,
    read_encrypted_export,
    restore_owner_export,
    write_encrypted_export,
)
from app.core.models import AIProvider, Note, Project, User
from app.core.security import hash_password
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.asyncio
async def test_encrypted_owner_export_excludes_secrets_and_restores(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/export.db")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", factory)
    monkeypatch.setenv("AELYS_EXPORT_KEY", base64.urlsafe_b64encode(b"e" * 32).rstrip(b"=").decode())
    try:
        async with factory() as session:
            source = User(email="source@example.com", password_hash=hash_password("correct horse battery staple"))
            session.add(source)
            await session.flush()
            session.add(Project(owner_id=source.id, name="Exported project", description="safe"))
            session.add(Note(owner_id=source.id, title="Exported note", markdown_body="body"))
            session.add(AIProvider(owner_id=source.id, kind="claude", enabled=True, secret_ref="secret-ref"))
            await session.commit()
            payload = await build_owner_export(session, "source@example.com")
        assert "ai_provider_secrets" in payload["privacy"]["excluded"]
        assert "password_hash" not in str(payload)
        output = tmp_path / "owner.aelys-export"
        write_encrypted_export(output, payload)
        assert output.read_bytes().startswith(b"AELYS-EXPORT-1\n")
        loaded = read_encrypted_export(output)
        assert loaded["owner"]["email"] == "source@example.com"
        target_engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/restore.db")
        target_factory = async_sessionmaker(target_engine, expire_on_commit=False)
        async with target_engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with target_factory() as session:
            target = User(email="target@example.com", password_hash=hash_password("correct horse battery staple"))
            session.add(target)
            await session.commit()
            restored = await restore_owner_export(session, "target@example.com", loaded)
            assert restored >= 3
            projects = list((await session.execute(__import__("sqlalchemy").select(Project).where(Project.owner_id == target.id))).scalars())
            assert any(item.name == "Exported project" for item in projects)
        await target_engine.dispose()
    finally:
        await engine.dispose()
