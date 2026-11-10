from __future__ import annotations

import pytest
from app.ai.defaults import feature_provider
from app.core import db
from app.core.models import Base, User
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.asyncio
async def test_each_feature_uses_the_chosen_provider_and_model(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/defaults.db")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", factory)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            boot = await client.post("/api/v1/auth/bootstrap", json={"email": "defaults@example.com", "password": "correct horse battery staple"})
            headers = {"Authorization": f"Bearer {boot.json()['access_token']}"}
            ids = {}
            for kind in ("transcription", "claude", "openrouter"):
                ids[kind] = (await client.post("/api/v1/ai/providers", headers=headers, json={"kind": kind, "model_policy": {"default_model": "m"}})).json()["id"]
                assert (await client.put(f"/api/v1/ai/providers/{ids[kind]}/secret", headers=headers, json={"api_key": "sk-test-key"})).status_code < 300
            async with factory() as session:
                owner = (await session.execute(select(User.id))).scalar_one()

            async with factory() as session:
                # Nothing chosen: the oldest provider of the right kind, never the transcription one.
                assert (await feature_provider(session, owner, "english"))[0].kind == "claude"

            assert (await client.get("/api/v1/ai/defaults", headers=headers)).json() == {"chat": None, "english": None, "automation": None, "transcription": None}
            wrong = await client.put("/api/v1/ai/defaults", headers=headers, json={"english": {"provider_id": ids["transcription"]}})
            assert wrong.status_code == 422 and wrong.json()["detail"]["code"] == "PROVIDER_MISMATCH"
            saved = await client.put("/api/v1/ai/defaults", headers=headers, json={"english": {"provider_id": ids["openrouter"], "model": "openai/gpt-5"}})
            assert saved.json()["english"] == {"provider_id": ids["openrouter"], "model": "openai/gpt-5"}

            async with factory() as session:
                provider, _, model = await feature_provider(session, owner, "english")
                assert (provider.kind, model) == ("openrouter", "openai/gpt-5")
                assert (await feature_provider(session, owner, "automation"))[0].kind == "claude"
                assert (await feature_provider(session, owner, "transcription"))[0].kind == "transcription"
    finally:
        await engine.dispose()
