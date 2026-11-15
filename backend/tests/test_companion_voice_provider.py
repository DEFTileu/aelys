from types import SimpleNamespace

import httpx
import pytest
from app.companion import voice_provider as voice


@pytest.mark.asyncio
async def test_transcribe_pcm_sends_raw_pcm_multipart(monkeypatch):
    async def handle(request):
        body = await request.aread()
        assert request.url.path == '/v1/speech-to-text'
        assert request.headers['xi-api-key'] == 'secret'
        assert b'scribe_v1' in body and b'pcm_s16le_16' in body and b'\x01\x02PCM' in body
        return httpx.Response(200, json={'text': 'привет'})
    monkeypatch.setattr(voice, 'voice_transport', lambda: httpx.MockTransport(handle))
    assert await voice.transcribe_pcm(SimpleNamespace(model_policy_json={}), 'secret', b'\x01\x02PCM') == 'привет'


@pytest.mark.asyncio
@pytest.mark.parametrize(('response', 'code'), [(httpx.Response(500), 'VOICE_UNAVAILABLE'), (httpx.Response(200, content=b'bad'), 'VOICE_UNAVAILABLE'), (httpx.Response(200, json={'text': ''}), 'VOICE_EMPTY'), (httpx.Response(200, content=b'x' * 100001), 'VOICE_UNAVAILABLE')])
async def test_transcribe_errors_generic(monkeypatch, caplog, response, code):
    monkeypatch.setattr(voice, 'voice_transport', lambda: httpx.MockTransport(lambda request: response))
    with pytest.raises(voice.VoiceError) as exc:
        await voice.transcribe_pcm(SimpleNamespace(model_policy_json={}), 'secret', b'pcm')
    assert exc.value.code == code and 'secret' not in str(exc.value) + caplog.text


@pytest.mark.asyncio
async def test_speak_reframes(monkeypatch):
    chunks = [b'a', b'b' * 4095, b'c' * 9000, b'd' * 3]
    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for chunk in chunks:
                yield chunk
    def handle(request):
        assert request.url.path == '/v1/text-to-speech/custom/stream'
        assert request.url.params['output_format'] == 'pcm_16000'
        assert b'eleven_flash_v2_5' in request.content
        return httpx.Response(200, stream=Stream())
    monkeypatch.setattr(voice, 'voice_transport', lambda: httpx.MockTransport(handle))
    output = [chunk async for chunk in voice.speak_pcm(SimpleNamespace(model_policy_json={'voice_id': 'custom'}), 'secret', 'hello')]
    assert all(len(chunk) <= 4096 and len(chunk) % 2 == 0 for chunk in output)
    assert b''.join(output) == b''.join(chunks)[:-1]
