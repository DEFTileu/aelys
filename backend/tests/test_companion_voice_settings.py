"""ElevenLabs is an owner-configured provider reserved for companion voice."""
from app.ai.defaults import feature_provider
from app.core.models import User
from sqlalchemy import select

pytest_plugins = ('test_telegram_business',)


async def test_elevenlabs_provider_accepts_only_official_host(setup):
    client, _, _ = setup
    accepted = await client.post('/api/v1/ai/providers', json={'kind': 'elevenlabs', 'base_url': 'https://api.elevenlabs.io'})
    assert accepted.status_code == 200, accepted.text
    for endpoint in ('https://evil.example', 'http://api.elevenlabs.io', 'https://api.elevenlabs.io/v1'):
        rejected = await client.post('/api/v1/ai/providers', json={'kind': 'elevenlabs', 'base_url': endpoint})
        assert rejected.status_code == 422, rejected.text
        assert rejected.json()['detail']['code'] == 'INVALID_PROVIDER_ENDPOINT'


async def test_voice_feature_picks_only_elevenlabs(setup):
    client, sessions, _ = setup
    ids = {}
    for kind in ('claude', 'transcription', 'elevenlabs'):
        response = await client.post('/api/v1/ai/providers', json={'kind': kind, 'model_policy': {'default_model': 'm'}})
        assert response.status_code == 200, response.text
        ids[kind] = response.json()['id']
        await client.put(f"/api/v1/ai/providers/{ids[kind]}/secret", json={'api_key': 'synthetic-provider-key'})
    async with sessions() as db:
        owner_id = (await db.execute(select(User.id))).scalar_one()
        voice = await feature_provider(db, owner_id, 'voice')
        assert voice[0].id == ids['elevenlabs']
        assert voice[0].kind == 'elevenlabs'
        chat = await feature_provider(db, owner_id, 'chat')
        assert chat is not None and chat[0].id == ids['claude']


async def test_elevenlabs_cannot_be_chat_default(setup):
    client, _, _ = setup
    provider = await client.post('/api/v1/ai/providers', json={'kind': 'elevenlabs', 'model_policy': {'default_model': 'eleven_flash_v2_5'}})
    assert provider.status_code == 200, provider.text
    refused = await client.put('/api/v1/ai/defaults', json={'chat': {'provider_id': provider.json()['id']}})
    assert refused.status_code == 422
    assert refused.json()['detail']['code'] == 'PROVIDER_MISMATCH'
