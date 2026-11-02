import asyncio
from types import SimpleNamespace

import pytest
from app.integrations import telegram_avatar
from fastapi import HTTPException

JPEG = b"\xff\xd8\xff" + b"\x00" * 32


class FakeClient:
    calls = 0

    def __init__(self, token):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    async def get_user_profile_photos(self, user_id):
        FakeClient.calls += 1
        if user_id == 7:
            return {"photos": [[{"file_id": "small", "width": 160}, {"file_id": "big", "width": 640}]]}
        return {"photos": []}

    async def get_file(self, file_id):
        assert file_id == "small"
        return {"file_path": "photos/a.jpg"}

    async def download_file(self, path, max_bytes):
        return JPEG


@pytest.fixture(autouse=True)
def patched(monkeypatch):
    telegram_avatar._cache.clear()
    FakeClient.calls = 0
    monkeypatch.setattr(telegram_avatar, "TelegramClient", FakeClient)
    monkeypatch.setattr(telegram_avatar, "decrypt_secret", lambda value: "token")


def item():
    return SimpleNamespace(id="i1", enabled=True, deleted_at=None, encrypted_token="x")


def test_avatar_is_fetched_once_then_served_from_memory():
    first = asyncio.run(telegram_avatar.chat_avatar(item(), 7))
    second = asyncio.run(telegram_avatar.chat_avatar(item(), 7))
    assert first == second == (JPEG, "image/jpeg")
    assert FakeClient.calls == 1


def test_missing_avatar_is_404_and_remembered():
    for _ in range(2):
        with pytest.raises(HTTPException) as caught:
            asyncio.run(telegram_avatar.chat_avatar(item(), 8))
        assert caught.value.status_code == 404
    assert FakeClient.calls == 1


def test_paused_integration_is_refused_and_forget_clears_cache():
    paused = item()
    paused.enabled = False
    with pytest.raises(HTTPException) as caught:
        asyncio.run(telegram_avatar.chat_avatar(paused, 7))
    assert caught.value.status_code == 409
    asyncio.run(telegram_avatar.chat_avatar(item(), 7))
    telegram_avatar.forget("i1")
    assert not telegram_avatar._cache
