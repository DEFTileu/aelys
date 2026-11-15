import base64
import logging
from decimal import Decimal

import httpx
import pytest
from app.ai import voice_api
from app.ai.crypto import encrypt_secret
from app.companion import voice_provider
from app.core.models import AIConversation, AIProvider, AIProviderSecret, AIRun, User
from sqlalchemy import select

pytest_plugins = ("test_english",)


async def add_voice_provider(sessions, *, budget="10"):
    async with sessions() as session:
        owner = (await session.execute(select(User.id))).scalar_one()
        provider = AIProvider(
            owner_id=owner,
            kind="elevenlabs",
            enabled=True,
            model_policy_json={"monthly_budget": budget, "voice_request_cost": "0.05"},
        )
        session.add(provider)
        await session.flush()
        session.add(
            AIProviderSecret(
                owner_id=owner,
                provider_id=provider.id,
                encrypted_value=encrypt_secret("synthetic-voice-key"),
            )
        )
        await session.commit()
        return provider.id


async def runs(sessions):
    async with sessions() as session:
        return list((await session.execute(select(AIRun))).scalars())


@pytest.mark.asyncio
async def test_voice_transcribe_rejects_unconfigured_provider_and_bad_mime(client):
    api, _ = client
    unconfigured = await api.post(
        "/api/v1/ai/voice/transcribe", content=b"voice", headers={"content-type": "audio/webm"}
    )
    assert unconfigured.status_code == 409
    assert unconfigured.json()["detail"]["code"] == "VOICE_NOT_CONFIGURED"

    unsupported = await api.post(
        "/api/v1/ai/voice/transcribe", content=b"voice", headers={"content-type": "audio/flac"}
    )
    assert unsupported.status_code == 415


@pytest.mark.asyncio
async def test_voice_transcribe_records_completed_run_and_hides_voice_conversation(client, monkeypatch):
    api, sessions = client
    await add_voice_provider(sessions)
    calls = []

    def handler(request):
        calls.append(request)
        assert request.headers["xi-api-key"] == "synthetic-voice-key"
        assert request.url.path == "/v1/speech-to-text"
        assert b"private voice bytes" in request.content
        return httpx.Response(200, json={"text": "  Hello from voice.  ", "language_code": "en"})

    monkeypatch.setattr(voice_provider, "voice_transport", lambda: httpx.MockTransport(handler))
    response = await api.post(
        "/api/v1/ai/voice/transcribe",
        content=b"private voice bytes",
        headers={"content-type": "audio/webm;codecs=opus"},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"text": "Hello from voice."}
    assert len(calls) == 1
    assert (await api.get("/api/v1/ai/conversations")).json() == []
    stored_runs = await runs(sessions)
    assert len(stored_runs) == 1
    assert stored_runs[0].status == "completed"
    assert stored_runs[0].provider == "elevenlabs"
    assert stored_runs[0].cost_estimate == Decimal("0.05000000")
    async with sessions() as session:
        conversation = await session.get(AIConversation, stored_runs[0].conversation_id)
        assert conversation.deleted_at is not None


@pytest.mark.asyncio
async def test_voice_budget_exceeded_does_not_call_provider(client, monkeypatch):
    api, sessions = client
    await add_voice_provider(sessions, budget="0.01")
    monkeypatch.setattr(voice_provider, "voice_transport", lambda: httpx.MockTransport(lambda _: pytest.fail("provider called")))
    response = await api.post(
        "/api/v1/ai/voice/transcribe", content=b"voice", headers={"content-type": "audio/webm"}
    )
    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "BUDGET_EXCEEDED"
    assert await runs(sessions) == []


@pytest.mark.asyncio
async def test_voice_provider_failure_is_redacted_and_marks_run_failed(client, monkeypatch, caplog):
    api, sessions = client
    await add_voice_provider(sessions)

    def handler(request):
        return httpx.Response(
            401,
            text="synthetic-voice-key https://api.elevenlabs.io/private-path private provider response",
        )

    monkeypatch.setattr(voice_provider, "voice_transport", lambda: httpx.MockTransport(handler))
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.WARNING, logger="sqlalchemy.engine")
    caplog.clear()
    response = await api.post(
        "/api/v1/ai/voice/transcribe",
        content=b"private voice bytes",
        headers={"content-type": "audio/webm"},
    )
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "VOICE_UNAVAILABLE"
    for private_value in (
        "synthetic-voice-key",
        "https://api.elevenlabs.io/private-path",
        "private provider response",
        "private voice bytes",
    ):
        assert private_value not in response.text
        assert private_value not in caplog.text
    stored_runs = await runs(sessions)
    assert len(stored_runs) == 1 and stored_runs[0].status == "failed"


@pytest.mark.asyncio
async def test_corrupt_voice_secret_is_redacted_without_reserving_run(client):
    api, sessions = client
    provider_id = await add_voice_provider(sessions)
    async with sessions() as session:
        secret = await session.get(AIProviderSecret, provider_id)
        secret.encrypted_value = "synthetic-corrupt-ciphertext"
        await session.commit()

    response = await api.post(
        "/api/v1/ai/voice/transcribe", content=b"voice", headers={"content-type": "audio/webm"}
    )
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "VOICE_UNAVAILABLE"
    assert "synthetic-corrupt-ciphertext" not in response.text
    assert "InvalidTag" not in response.text
    assert await runs(sessions) == []


@pytest.mark.asyncio
async def test_voice_speak_returns_base64_mp3(client, monkeypatch):
    api, sessions = client
    await add_voice_provider(sessions)
    calls = []

    def handler(request):
        calls.append(request)
        assert request.headers["xi-api-key"] == "synthetic-voice-key"
        assert request.url.params["output_format"] == "mp3_44100_64"
        return httpx.Response(200, content=b"synthetic mp3 bytes")

    monkeypatch.setattr(voice_provider, "voice_transport", lambda: httpx.MockTransport(handler))
    response = await api.post("/api/v1/ai/voice/speak", json={"text": "Hello there."})
    assert response.status_code == 200, response.text
    assert response.json() == {
        "audio": base64.b64encode(b"synthetic mp3 bytes").decode(),
        "content_type": "audio/mpeg",
    }
    assert response.headers["Cache-Control"] == "no-store"
    assert len(calls) == 1
    assert (await runs(sessions))[0].status == "completed"


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("# Heading\n\nA **bold** answer.", "Heading A bold answer."),
        ("Read [the guide](https://example.test/guide).", "Read the guide."),
        ("Say `x = 1` aloud.", "Say x = 1 aloud."),
        ("Before ```python\nprint('secret')\n``` after.", "Before after."),
        ("Before ~~~python\nprint('secret')\n~~~ after.", "Before after."),
        ("Read [the guide][guide].\n\n[guide]: https://example.test/guide", "Read the guide."),
        ("Read <em>this</em>, not <script>private()</script>.", "Read this, not ."),
        ("See https://example.test/path now.", "See now."),
        ("x" * 2600, "x" * 2500),
        ("   ` ``\n", ""),
    ],
)
def test_speakable_text(source, expected):
    assert voice_api.speakable(source) == expected


@pytest.mark.asyncio
async def test_voice_speak_rejects_empty_speakable_text(client):
    api, _ = client
    response = await api.post("/api/v1/ai/voice/speak", json={"text": "```python\nprint('hidden')\n```"})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "VOICE_EMPTY"


@pytest.mark.asyncio
async def test_voice_validation_error_does_not_echo_input(client):
    api, _ = client
    private_text = "synthetic private voice payload " * 800
    response = await api.post("/api/v1/ai/voice/speak", json={"text": private_text})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "VALIDATION_ERROR"
    assert private_text not in response.text
    assert "synthetic private voice payload" not in response.text


@pytest.mark.parametrize('route', ['transcribe', 'speak'])
@pytest.mark.asyncio
async def test_voice_cancellation_finishes_reserved_run(client, monkeypatch, route):
    import asyncio

    from app.ai import voice_api

    api, sessions = client
    await add_voice_provider(sessions)

    async def cancelled(*args, **kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(voice_api, 'transcribe' if route == 'transcribe' else 'speak_mp3', cancelled)
    with pytest.raises((asyncio.CancelledError, RuntimeError)):
        if route == 'transcribe':
            await api.post('/api/v1/ai/voice/transcribe', content=b'voice', headers={'content-type': 'audio/webm'})
        else:
            await api.post('/api/v1/ai/voice/speak', json={'text': 'Hello.'})
    stored = await runs(sessions)
    assert len(stored) == 1
    assert stored[0].status == 'failed'
    assert stored[0].completed_at is not None


def test_speakable_removes_indented_code():
    from app.ai.voice_api import speakable
    assert speakable('Intro.\n\n    do_private_thing()\n    secret = 42\n\nEnd.') == 'Intro. End.'


@pytest.mark.parametrize(('budget', 'status', 'calls', 'cost'), [('0.05', 429, 1, '0.05'), ('0.10', 200, 2, '0.10')])
@pytest.mark.asyncio
async def test_language_retry_reserves_another_request(client, monkeypatch, budget, status, calls, cost):
    api, sessions = client
    await add_voice_provider(sessions, budget=budget)
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={'text': 'Hello', 'language_code': 'por' if len(seen) == 1 else 'rus'})

    monkeypatch.setattr(voice_provider, 'voice_transport', lambda: httpx.MockTransport(handler))
    response = await api.post('/api/v1/ai/voice/transcribe', content=b'voice', headers={'content-type': 'audio/webm'})
    assert response.status_code == status
    assert len(seen) == calls
    stored = (await runs(sessions))[0]
    assert stored.cost_estimate == Decimal(cost)
    assert stored.status == ('completed' if status == 200 else 'failed')
