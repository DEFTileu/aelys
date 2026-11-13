"""Optional quotes and ephemeral owner-authorized Business media previews."""

import json
from uuid import uuid4

import pytest
from app.integrations import telegram_service as service
from app.integrations.telegram_models import (
    TelegramBusinessMessage,
    TelegramIntegration,
)
from sqlalchemy import text
from test_telegram_business import CUSTOMER, PREFIX, ingest, message
from test_telegram_chat_send import ready, send

pytest_plugins = ("test_telegram_business",)


async def test_secretary_send_is_an_ordinary_message_by_default(setup, monkeypatch):
    client, _, fake, _ = await ready(setup, monkeypatch)
    row = (await client.get(PREFIX + "/messages")).json()[0]
    response = await client.post(
        PREFIX + f"/messages/{row['id']}/send",
        json={"version": row["version"], "text": "Plain reply"},
    )
    assert response.status_code == 200, response.text
    assert fake.sent[-1][2] == {"business_connection_id": "business-1"}


async def test_selected_reply_target_is_sent_persisted_and_key_bound(
    setup, monkeypatch
):
    client, _, fake, _ = await ready(setup, monkeypatch)
    key = str(uuid4())
    response = await send(client, "Explicit reply", key=key, reply_to_message_id=7)
    assert response.status_code == 200, response.text
    assert fake.sent[-1][2] == {
        "business_connection_id": "business-1",
        "reply_to_message_id": 7,
    }
    assert response.json()["reply_to_telegram_message_id"] == 7
    assert (
        await send(client, "Explicit reply", key=key, reply_to_message_id=7)
    ).status_code == 200
    assert (await send(client, "Explicit reply", key=key)).status_code == 409
    assert len(fake.sent) == 1


async def test_unknown_or_other_chat_reply_target_cannot_be_quoted(setup, monkeypatch):
    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    other = message(2, message_id=88)
    other["business_message"]["chat"]["id"] = 444
    other["business_message"]["from"]["id"] = 444
    await ingest(sessions, integration_id, other, fake)
    for remote_id in [88, 999]:
        response = await send(
            client, "No cross chat reply", reply_to_message_id=remote_id
        )
        assert response.status_code == 404, response.text
    assert fake.sent == []


def media_update(kind="photo", update_id=2, **patch):
    value = message(update_id, message_id=20)
    raw = value["business_message"]
    raw.pop("text")
    metadata = {"file_id": "synthetic-private-file-id", "file_size": 32}
    raw[kind] = (
        [{**metadata, "width": 64, "height": 64}]
        if kind == "photo"
        else {**metadata, "mime_type": "audio/ogg"}
    )
    raw.update(patch)
    return value


@pytest.mark.parametrize("kind", ["photo", "voice", "audio"])
async def test_ingest_stores_only_encrypted_metadata_and_exposes_safe_media_descriptor(
    setup, monkeypatch, kind
):
    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    await ingest(
        sessions, integration_id, media_update(kind, caption="Media caption"), fake
    )
    rows = (await client.get(PREFIX + "/messages")).json()
    media = next(row for row in rows if row["telegram_message_id"] == 20)
    assert media["text"] == "Media caption" and media["media"]["kind"] == kind
    assert "synthetic-private-file-id" not in json.dumps(rows)
    async with sessions() as db:
        raw = (
            await db.execute(
                text(
                    "SELECT media_metadata FROM telegram_business_messages WHERE id=:id"
                ),
                {"id": media["id"]},
            )
        ).scalar_one()
        assert "synthetic-private-file-id" not in raw and raw
    assert not fake.sent


@pytest.mark.parametrize(
    "kind,data,content_type",
    [
        ("photo", b"\x89PNG\r\n\x1a\n" + b"png-body", "image/png"),
        ("voice", b"OggS" + b"audio-body", "audio/ogg"),
        ("audio", b"ID3" + b"mp3-body", "audio/mpeg"),
    ],
)
async def test_authenticated_media_preview_is_bounded_uncached_and_not_persisted(
    setup, monkeypatch, kind, data, content_type
):
    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    await ingest(sessions, integration_id, media_update(kind), fake)
    media = next(
        row
        for row in (await client.get(PREFIX + "/messages")).json()
        if row["telegram_message_id"] == 20
    )
    calls = []

    async def get_file(self, file_id):
        calls.append(("file", file_id))
        return {"file_path": "photos/test.bin", "file_size": len(data)}

    async def download(self, path, max_bytes):
        calls.append(("download", path, max_bytes))
        return data

    monkeypatch.setattr(fake, "get_file", get_file, raising=False)
    monkeypatch.setattr(fake, "download_file", download, raising=False)
    response = await client.get(PREFIX + f"/messages/{media['id']}/media")
    assert response.status_code == 200, response.text
    assert response.content == data and response.headers["content-type"].startswith(
        content_type
    )
    assert (
        response.headers["cache-control"] == "no-store"
        and response.headers["x-content-type-options"] == "nosniff"
    )
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert "synthetic-private-file-id" not in str(response.headers)
    async with sessions() as db:
        item = await db.get(TelegramBusinessMessage, media["id"])
        assert data.hex() not in item.media_metadata
    headers = dict(client.headers)
    client.headers.pop("Authorization")
    assert (
        await client.get(PREFIX + f"/messages/{media['id']}/media")
    ).status_code == 401
    client.headers.update(headers)
    assert len(calls) == 2


@pytest.mark.parametrize(
    "case", ["oversize", "html", "deleted", "disabled", "foreign", "policy"]
)
async def test_media_errors_never_expose_bytes_paths_or_tokens(
    setup, monkeypatch, case
):
    from app.ai.errors import PolicyDenied
    from app.ai.policy import ServerPolicyEngine

    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    await ingest(sessions, integration_id, media_update(), fake)
    media = next(
        row
        for row in (await client.get(PREFIX + "/messages")).json()
        if row["telegram_message_id"] == 20
    )
    downloads = []

    async def get_file(self, id):
        return {
            "file_path": "photos/private",
            "file_size": 11 * 1024 * 1024 if case == "oversize" else 12,
        }

    async def download(self, path, limit):
        downloads.append(path)
        return b"<html>secret</html>"

    monkeypatch.setattr(fake, "get_file", get_file, raising=False)
    monkeypatch.setattr(fake, "download_file", download, raising=False)
    async with sessions() as db:
        row = await db.get(TelegramBusinessMessage, media["id"])
        if case == "deleted":
            row.deleted_at = service.now()
        if case == "disabled":
            (await db.get(TelegramIntegration, integration_id)).enabled = False
        if case == "foreign":
            row.owner_id = "someone-else"
        await db.commit()
    if case == "policy":

        def deny(*args, **kwargs):
            raise PolicyDenied("private diagnostic")

        monkeypatch.setattr(ServerPolicyEngine, "authorize", deny)
    response = await client.get(PREFIX + f"/messages/{media['id']}/media")
    assert response.status_code in (403, 404, 409, 413, 415, 422), response.text
    assert (
        "synthetic-private-file-id" not in response.text
        and "<html>" not in response.text
        and "private diagnostic" not in response.text
    )
    if case != "html":
        assert not downloads


async def test_new_customer_audio_on_fast_poll_suppresses_stale_text_reply_without_ai_media_processing(
    setup, monkeypatch
):
    from app.integrations import telegram_ai
    from app.integrations.telegram_ai import BusinessDecision

    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        item.auto_reply = True
        item.reply_delay_seconds = 0
        await db.commit()
    fake.updates = [media_update("voice", update_id=9)]
    calls = []

    async def generate(*args):
        calls.append(1)
        return BusinessDecision("reply", "Stale answer", None)

    monkeypatch.setattr(telegram_ai, "generate_business_draft", generate)
    await service.auto_reply_once(integration_id)
    assert not fake.sent and calls == [1]
    await service.auto_reply_once(integration_id)
    assert not fake.sent and calls == [1]
    rows = (await client.get(PREFIX + "/messages")).json()
    assert any(row["media"] and row["media"]["kind"] == "voice" for row in rows)


async def test_photo_draft_uses_existing_permission_checked_generation(setup, monkeypatch):
    from app.integrations import telegram_ai
    from app.integrations.telegram_ai import BusinessDecision

    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    await ingest(sessions, integration_id, media_update(), fake)
    media = next(row for row in (await client.get(PREFIX + '/messages')).json() if row['telegram_message_id'] == 20)
    calls = []

    async def generate(db, integration, message):
        calls.append(message.id)
        return BusinessDecision('reply', 'Скриншоттағы қатені көріп тұрмын.', None)

    monkeypatch.setattr(telegram_ai, 'generate_business_draft', generate)
    response = await client.post(PREFIX + f"/messages/{media['id']}/draft", json={'version': media['version']})
    assert response.status_code == 200, response.text
    assert response.json()['draft_status'] == 'ready' and calls == [media['id']]
    assert not fake.sent


@pytest.mark.parametrize("mutation", ["delete", "disconnect", "replace_media"])
async def test_download_rechecks_current_authority_and_message_after_io(
    setup, monkeypatch, mutation
):
    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    await ingest(sessions, integration_id, media_update(), fake)
    media = next(
        row
        for row in (await client.get(PREFIX + "/messages")).json()
        if row["telegram_message_id"] == 20
    )

    async def get_file(self, id):
        return {"file_path": "photos/test.png", "file_size": 32}

    async def download(self, path, limit):
        async with sessions() as db:
            if mutation == "disconnect":
                item = await db.get(TelegramIntegration, integration_id)
                item.enabled = False
                item.encrypted_token = None
                await service.purge_integration(db, item)
            else:
                row = await db.get(TelegramBusinessMessage, media["id"])
                if mutation == "delete":
                    row.deleted_at = service.now()
                    row.media_metadata = None
                else:
                    row.media_metadata = json.dumps(
                        {"kind": "photo", "file_id": "new-file"}
                    )
            await db.commit()
        return b"\x89PNG\r\n\x1a\n" + b"private-bytes"

    monkeypatch.setattr(fake, "get_file", get_file, raising=False)
    monkeypatch.setattr(fake, "download_file", download, raising=False)
    result = await client.get(PREFIX + f"/messages/{media['id']}/media")
    assert result.status_code == 404 and b"private-bytes" not in result.content


async def test_deleted_update_erases_media_and_quote_reference(setup, monkeypatch):
    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    update = media_update(reply_to_message={"message_id": 7})
    await ingest(sessions, integration_id, update, fake)
    row = next(
        row
        for row in (await client.get(PREFIX + "/messages")).json()
        if row["telegram_message_id"] == 20
    )
    assert row["reply_to_telegram_message_id"] == 7
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        await service.ingest_update(
            db,
            item,
            {
                "deleted_business_messages": {
                    "business_connection_id": "business-1",
                    "chat": {"id": CUSTOMER, "type": "private"},
                    "message_ids": [20],
                }
            },
            fake("123456:" + "z" * 30),
        )
        await db.commit()
        record = await db.get(TelegramBusinessMessage, row["id"])
        assert (
            record.media_metadata is None
            and record.reply_to_telegram_message_id is None
            and record.deleted_at
        )
    assert (
        await client.get(PREFIX + f"/messages/{row['id']}/media")
    ).status_code == 404
