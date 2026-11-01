"""BYOK transcription uses encrypted owner credentials and in-memory transport."""
import httpx
import pytest
from app.ai.crypto import encrypt_secret
from app.core.models import AIProvider, AIProviderSecret
from app.integrations.telegram_models import TelegramIntegration

pytest_plugins=('test_telegram_business',)


async def test_missing_transcription_key_does_not_call_provider(setup,monkeypatch):
    from app.integrations.telegram_transcription import transcribe_audio
    from test_telegram_personal import bound
    _,sessions,_,integration_id=await bound(setup)
    async with sessions() as db:
        item=await db.get(TelegramIntegration,integration_id)
        with pytest.raises(Exception,match='TRANSCRIPTION_NOT_CONFIGURED'):
            await transcribe_audio(db,item,b'private audio','audio/ogg','voice.ogg')


async def test_transcription_multipart_secret_not_exposed(setup,monkeypatch,caplog):
    from app.integrations import telegram_transcription as transcription
    from test_telegram_personal import bound
    _,sessions,_,integration_id=await bound(setup)
    captured=[]
    def handler(request):
        captured.append(request)
        assert request.headers['authorization']=='Bearer synthetic-audio-provider-key'
        assert request.url.path=='/v1/audio/transcriptions'
        assert b'private audio bytes' in request.content and b'name="model"' in request.content
        assert b'audio-test' in request.content and b'name="file"' in request.content
        return httpx.Response(200,json={'text':'Создай задачу Позвонить'})
    monkeypatch.setattr(transcription,'transcription_transport',lambda:httpx.MockTransport(handler))
    async with sessions() as db:
        item=await db.get(TelegramIntegration,integration_id)
        provider=AIProvider(owner_id=item.owner_id,kind='transcription',enabled=True,model_policy_json={'default_model':'audio-test'})
        db.add(provider);await db.flush()
        db.add(AIProviderSecret(owner_id=item.owner_id,provider_id=provider.id,encrypted_value=encrypt_secret('synthetic-audio-provider-key')))
        await db.commit()
        text=await transcription.transcribe_audio(db,item,b'private audio bytes','audio/ogg','voice.ogg')
        assert text=='Создай задачу Позвонить'
        assert 'private audio bytes' not in caplog.text and 'synthetic-audio-provider-key' not in caplog.text
    assert len(captured)==1


@pytest.mark.parametrize('response',[httpx.Response(401,text='synthetic-audio-provider-key private'),
    httpx.Response(200,json={'text':'x'*20001}),httpx.Response(200,json={'text':''}),httpx.Response(200,json={'bad':'value'})])
async def test_transcription_invalid_response_is_generic(setup,monkeypatch,response):
    from app.integrations import telegram_transcription as transcription
    from test_telegram_personal import bound
    _,sessions,_,integration_id=await bound(setup)
    monkeypatch.setattr(transcription,'transcription_transport',lambda:httpx.MockTransport(lambda r:response))
    async with sessions() as db:
        item=await db.get(TelegramIntegration,integration_id)
        provider=AIProvider(owner_id=item.owner_id,kind='transcription',enabled=True,model_policy_json={'default_model':'audio-test'})
        db.add(provider);await db.flush()
        db.add(AIProviderSecret(owner_id=item.owner_id,provider_id=provider.id,encrypted_value=encrypt_secret('synthetic-audio-provider-key')))
        await db.commit()
        with pytest.raises(transcription.TranscriptionError) as caught:
            await transcription.transcribe_audio(db,item,b'private','audio/ogg','voice.ogg')
        assert str(caught.value)=='TRANSCRIPTION_UNAVAILABLE'


async def test_transcription_provider_is_separate_owner_api_and_cannot_be_chat(setup):
    client,_,_=setup
    result=await client.post('/api/v1/ai/providers',json={'kind':'transcription','model_policy':{'default_model':'audio-test'}})
    assert result.status_code==200,result.text
    provider_id=result.json()['id']
    stored=await client.put(f'/api/v1/ai/providers/{provider_id}/secret',json={'api_key':'synthetic-audio-api-key'})
    assert stored.status_code==200
    listed=await client.get('/api/v1/ai/providers')
    assert 'synthetic-audio-api-key' not in listed.text and listed.json()[0]['has_secret']
    conversation=(await client.post('/api/v1/ai/conversations',json={})).json()
    run=await client.post('/api/v1/ai/runs',json={'conversation_id':conversation['id'],'message':'chat',
        'routing':{'provider_id':provider_id},'idempotency_key':'no-audio-chat'})
    assert run.status_code==404
    for endpoint in ['http://api.openai.com','https://127.0.0.1','https://api.openai.com@invalid.test',
                     'https://api.openai.com:bad','https://api.openai.com?api_key=private']:
        result=await client.post('/api/v1/ai/providers',json={'kind':'transcription','base_url':endpoint})
        assert result.status_code==422,result.text


async def test_transcription_reserves_budget_before_transport_and_exhausts_it(setup,monkeypatch):
    from app.core.models import AIRun
    from app.integrations import telegram_transcription as transcription
    from sqlalchemy import select
    from test_telegram_personal import bound
    _,sessions,_,integration_id=await bound(setup)
    calls=[]
    async def handler(request):
        async with sessions() as separate:
            run=(await separate.execute(select(AIRun).where(AIRun.provider=='transcription'))).scalar_one()
            assert run.status=='running' and run.cost_estimate==__import__('decimal').Decimal('0.01')
        calls.append(True)
        return httpx.Response(200,json={'text':'Привет'})
    monkeypatch.setattr(transcription,'transcription_transport',lambda:httpx.MockTransport(handler))
    async with sessions() as db:
        item=await db.get(TelegramIntegration,integration_id)
        provider=AIProvider(owner_id=item.owner_id,kind='transcription',enabled=True,
            model_policy_json={'default_model':'audio-test','monthly_budget':'0.01','transcription_request_cost':'0.01'})
        db.add(provider);await db.flush()
        db.add(AIProviderSecret(owner_id=item.owner_id,provider_id=provider.id,encrypted_value=encrypt_secret('synthetic-audio-provider-key')))
        await db.commit()
        assert await transcription.transcribe_audio(db,item,b'private','audio/ogg','voice.ogg')=='Привет'
        with pytest.raises(transcription.TranscriptionError,match='BUDGET_EXCEEDED'):
            await transcription.transcribe_audio(db,item,b'private','audio/ogg','voice.ogg')
        assert len(calls)==1


@pytest.mark.parametrize('estimate',['0.0000000001','0','-1','NaN','Infinity'])
async def test_invalid_or_subprecision_transcription_estimate_cannot_bypass_budget(setup,monkeypatch,estimate):
    from app.integrations import telegram_transcription as transcription
    from test_telegram_personal import bound
    _,sessions,_,integration_id=await bound(setup)
    def no_transport():raise AssertionError('Invalid estimate must refuse before external request')
    monkeypatch.setattr(transcription,'transcription_transport',no_transport)
    async with sessions() as db:
        item=await db.get(TelegramIntegration,integration_id)
        provider=AIProvider(owner_id=item.owner_id,kind='transcription',enabled=True,
            model_policy_json={'default_model':'audio-test','monthly_budget':'1','transcription_request_cost':estimate})
        db.add(provider);await db.flush()
        db.add(AIProviderSecret(owner_id=item.owner_id,provider_id=provider.id,encrypted_value=encrypt_secret('synthetic-audio-provider-key')))
        await db.commit()
        with pytest.raises(transcription.TranscriptionError,match='BUDGET_EXCEEDED'):
            await transcription.transcribe_audio(db,item,b'private','audio/ogg','voice.ogg')
