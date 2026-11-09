"""Bounded memory-only Telegram downloads; all HTTP is mocked at transport."""
import asyncio
import builtins
import io
import json
import logging
import traceback
from dataclasses import asdict
from pathlib import Path

import httpx
import pytest
from app.ai.crypto import encrypt_secret
from app.ai.errors import PolicyDenied
from app.ai.policy import ServerPolicyEngine
from app.integrations import telegram_service as service
from app.integrations.telegram_media import (
    TelegramMedia,
    TelegramMediaError,
    download_media,
    parse_owner_media,
)
from app.integrations.telegram_business_media import content_type, parse_business_media
from app.integrations.telegram_models import TelegramIntegration
from app.integrations.telegram_transport import TelegramClient, TelegramError

TOKEN = '12345:secret_media_token'
FILE_PATH = 'voice/private_file.oga'
MIB = 1024 * 1024


class Stream(httpx.AsyncByteStream):
    def __init__(self, chunks, failure=None):
        self.chunks = chunks
        self.failure = failure
        self.read = 0
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            self.read += 1
            yield chunk
        if self.failure:
            raise self.failure

    async def aclose(self):
        self.closed = True


async def test_get_file_uses_object_contract_and_download_is_streamed_without_disk(monkeypatch, caplog):
    requests = []
    stream = Stream([b'hello', b' world'])

    async def handler(request):
        requests.append(request)
        if request.method == 'POST':
            assert request.url.path == f'/bot{TOKEN}/getFile'
            assert json.loads(request.content) == {'file_id': 'safe-id'}
            return httpx.Response(200, json={'ok': True, 'result': {'file_path': FILE_PATH, 'file_size': 11}})
        assert request.url == f'https://api.telegram.org/file/bot{TOKEN}/{FILE_PATH}'
        assert request.headers['accept-encoding'] == 'identity'
        return httpx.Response(200, stream=stream)

    def deny_disk(*_args, **_kwargs):
        raise AssertionError('Media bytes must not touch the filesystem')

    async with TelegramClient(TOKEN, httpx.MockTransport(handler)) as client:
        with caplog.at_level(logging.DEBUG), monkeypatch.context() as patch:
            patch.setattr(builtins, 'open', deny_disk)
            patch.setattr(io, 'open', deny_disk)
            patch.setattr(Path, 'write_bytes', deny_disk)
            patch.setattr(Path, 'read_bytes', deny_disk)
            metadata = await client.get_file('safe-id')
            assert await client.download_file(metadata['file_path'], 11) == b'hello world'
    assert len(requests) == 2 and stream.read == 2 and stream.closed
    assert TOKEN not in caplog.text and FILE_PATH not in caplog.text and 'hello world' not in caplog.text


@pytest.mark.parametrize('value', [None, [], 'secret body', 1])
async def test_get_file_requires_object(value):
    async with TelegramClient(TOKEN, httpx.MockTransport(lambda _: httpx.Response(200, json={'ok': True, 'result': value}))) as client:
        with pytest.raises(TelegramError) as exc:
            await client.get_file('safe-id')
    assert exc.value.code == 'invalid_response'


@pytest.mark.parametrize('path', [
    '', '/voice/file.oga', '//evil.test/file', '../file', 'voice/../file', 'voice/./file',
    'voice//file', 'voice/file/', 'https://evil.test/file', 'file://etc/passwd',
    'voice/file?token=x', 'voice/file#fragment', 'voice\\file', 'voice/%2e%2e/file',
    'voice/%252e%252e/file', 'voice/hello\nfile', 'voice/file:abc', 'voice/a b', 'x' * 2049,
    None, 123,
])
async def test_invalid_download_path_never_reaches_transport(path):
    requests = []
    async with TelegramClient(TOKEN, httpx.MockTransport(lambda request: requests.append(request))) as client:
        with pytest.raises(TelegramError) as exc:
            await client.download_file(path, 20)
    assert exc.value.code == 'invalid_file_path'
    assert TOKEN not in str(exc.value) and 'voice/' not in str(exc.value)
    assert not requests


@pytest.mark.parametrize('limit', [0, -1, True, None, '20', 20 * MIB + 1])
async def test_invalid_byte_limit_never_reaches_transport(limit):
    requests = []
    async with TelegramClient(TOKEN, httpx.MockTransport(lambda request: requests.append(request))) as client:
        with pytest.raises(ValueError):
            await client.download_file(FILE_PATH, limit)
    assert not requests


@pytest.mark.parametrize('length', [None, '1', '10'])
async def test_actual_stream_limit_overrides_missing_or_false_content_length(length):
    stream = Stream([b'12345', b'67890', b'x', b'never read'])
    headers = {} if length is None else {'content-length': length}
    async with TelegramClient(TOKEN, httpx.MockTransport(lambda _: httpx.Response(200, headers=headers, stream=stream))) as client:
        with pytest.raises(TelegramError) as exc:
            await client.download_file(FILE_PATH, 10)
    assert exc.value.code == 'file_too_large'
    assert stream.read == 3 and stream.closed


@pytest.mark.parametrize('headers,code', [
    ({'content-length': '11'}, 'file_too_large'),
    ({'content-length': '-1'}, 'invalid_response'),
    ({'content-length': 'nonsense'}, 'invalid_response'),
    ({'content-encoding': 'gzip'}, 'invalid_response'),
])
async def test_headers_reject_before_body_read(headers, code):
    stream = Stream([b'never read'])
    async with TelegramClient(TOKEN, httpx.MockTransport(lambda _: httpx.Response(200, headers=headers, stream=stream))) as client:
        with pytest.raises(TelegramError) as exc:
            await client.download_file(FILE_PATH, 10)
    assert exc.value.code == code and stream.read == 0 and stream.closed


@pytest.mark.parametrize('status', [206, 301, 302, 307, 308, 403, 404, 500])
async def test_download_never_follows_redirect_or_reads_error_body(status):
    requests = []
    stream = Stream([TOKEN.encode()])

    def handler(request):
        requests.append(request)
        return httpx.Response(status, headers={'location': 'https://evil.test/' + TOKEN}, stream=stream)

    async with TelegramClient(TOKEN, httpx.MockTransport(handler)) as client:
        with pytest.raises(TelegramError) as exc:
            await client.download_file(FILE_PATH, 100)
    assert exc.value.code == status and len(requests) == 1
    assert stream.read == 0 and stream.closed
    assert TOKEN not in str(exc.value)


@pytest.mark.parametrize('failure,code', [
    (httpx.ReadTimeout(f'https://api.telegram.org/file/bot{TOKEN}/{FILE_PATH}'), 'timeout'),
    (httpx.ConnectError(f'https://api.telegram.org/file/bot{TOKEN}/{FILE_PATH}'), 'network_error'),
    (RuntimeError(f'https://api.telegram.org/file/bot{TOKEN}/{FILE_PATH}'), 'network_error'),
])
async def test_stream_errors_suppress_secret_tracebacks_and_close(failure, code):
    stream = Stream([b'partial'], failure)
    async with TelegramClient(TOKEN, httpx.MockTransport(lambda _: httpx.Response(200, stream=stream))) as client:
        with pytest.raises(TelegramError) as exc:
            await client.download_file(FILE_PATH, 100)
    formatted = ''.join(traceback.format_exception(exc.value))
    assert exc.value.code == code and stream.closed
    assert TOKEN not in formatted and FILE_PATH not in formatted
    assert exc.value.__suppress_context__


async def test_cancellation_closes_download_stream():
    entered = asyncio.Event()

    class BlockingStream(Stream):
        async def __aiter__(self):
            entered.set()
            await asyncio.Event().wait()
            yield b'unreachable'

    stream = BlockingStream([])
    async with TelegramClient(TOKEN, httpx.MockTransport(lambda _: httpx.Response(200, stream=stream))) as client:
        task = asyncio.create_task(client.download_file(FILE_PATH, 100))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    assert stream.closed


@pytest.mark.parametrize('logger_name', ['httpx', 'httpcore', 'httpcore.connection', 'httpcore.http11'])
def test_api_and_file_urls_in_messages_and_exception_traces_are_filtered(logger_name, caplog):
    logger = logging.getLogger(logger_name)
    with caplog.at_level(logging.DEBUG):
        for prefix in ('bot', 'file/bot'):
            url = f'https://api.telegram.org/{prefix}{TOKEN}/{FILE_PATH}'
            logger.warning('Request %s', url)
            try:
                raise RuntimeError(url)
            except RuntimeError:
                logger.exception('Generic request failure')
        logger.warning('Non-Telegram URL https://example.test/keep')
    assert TOKEN not in caplog.text and FILE_PATH not in caplog.text
    assert 'example.test/keep' in caplog.text


@pytest.mark.parametrize('field,kind,mime', [('voice', 'voice', 'audio/ogg'), ('audio', 'audio', 'audio/mpeg')])
def test_parse_audio_metadata_and_priority(field, kind, mime):
    message = {field: {'file_id': 'id', 'file_size': 20, 'mime_type': mime, 'file_name': 'clip.oga'},
               'document': {'file_id': 'doc', 'mime_type': 'application/pdf'}}
    media = parse_owner_media(message)
    assert asdict(media) == {'kind': kind, 'file_id': 'id', 'file_size': 20, 'mime_type': mime, 'filename': 'clip.oga', 'emoji': None}
    if kind == 'audio':
        message['voice'] = {'file_id': 'voice'}
        assert parse_owner_media(message).kind == 'voice'


def test_parse_largest_photo_by_resolution_not_order_or_compressed_size():
    media = parse_owner_media({'photo': [
        {'file_id': 'small', 'width': 40, 'height': 40, 'file_size': 1000},
        {'file_id': 'large', 'width': 200, 'height': 100, 'file_size': 500},
        {'file_id': 'medium', 'width': 100, 'height': 100, 'file_size': 2000},
    ], 'document': {'file_id': 'doc', 'mime_type': 'application/pdf'}})
    assert media.kind == 'photo' and media.file_id == 'large' and media.file_size == 500


@pytest.mark.parametrize('mime,filename,kind', [
    ('application/pdf', 'report.pdf', 'pdf'), ('text/plain', 'note.txt', 'text'),
    ('application/octet-stream', 'pretend.pdf', 'unsupported'), ('application/zip', 'note.txt', 'unsupported'),
    (None, 'note.txt', 'unsupported'),
])
def test_document_kind_uses_mime_not_filename(mime, filename, kind):
    media = parse_owner_media({'document': {'file_id': 'doc', 'mime_type': mime, 'file_name': filename}})
    assert media.kind == kind
    assert TelegramMedia(**json.loads(json.dumps(asdict(media)))) == media


@pytest.mark.parametrize('field', ['forward_origin', 'forward_from', 'forward_from_chat', 'sender_business_bot', 'business_connection_id'])
def test_forwarded_or_business_media_ignored(field):
    assert parse_owner_media({field: {'id': 2}, 'voice': {'file_id': 'id'}}) is None


def test_unsupported_and_bounded_untrusted_metadata():
    assert parse_owner_media({'text': 'normal owner text'}) is None
    assert parse_owner_media({'video': {'file_id': 'video'}}).kind == 'unsupported'
    for value in ({'document': []}, {'photo': []}, {'voice': {'file_id': 'x' * 513}}):
        media = parse_owner_media(value)
        assert media.kind == 'unsupported' and len(media.file_id) <= 512
    media = parse_owner_media({'document': {'file_id': 'x' * 512, 'mime_type': 'x' * 101, 'file_name': 'f' * 200, 'file_size': True}})
    assert media.kind == 'unsupported' and len(media.mime_type or '') <= 100 and len(media.filename or '') <= 128
    assert media.file_size is None


@pytest.fixture
def download_setup(monkeypatch):
    item = TelegramIntegration(id='integration', owner_id='owner', bot_id=1, bot_username='test',
        bot_name='Test', business_capable=True, encrypted_token=encrypt_secret(TOKEN),
        enabled=True, owner_telegram_id=111)
    calls = []
    state = {'data': b'content', 'metadata': {'file_path': FILE_PATH, 'file_size': 7}}

    class Transport:
        def __init__(self, token):
            assert token == TOKEN

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def get_file(self, file_id):
            calls.append(('get_file', file_id))
            return state['metadata']

        async def download_file(self, file_path, max_bytes):
            calls.append(('download_file', file_path, max_bytes))
            return state['data']

    monkeypatch.setattr(service, 'TelegramClient', Transport)
    return item, calls, state


@pytest.mark.parametrize('kind,limit', [('voice', 20 * MIB), ('audio', 20 * MIB), ('photo', 10 * MIB), ('pdf', 20 * MIB), ('text', 80_000)])
async def test_oversized_metadata_rejected_before_any_network(download_setup, kind, limit):
    item, calls, _ = download_setup
    with pytest.raises(TelegramMediaError) as exc:
        await download_media(item, TelegramMedia(kind=kind, file_id='id', file_size=limit + 1))
    assert exc.value.code == 'MEDIA_TOO_LARGE' and not calls


@pytest.mark.parametrize('kind,limit', [('voice', 20 * MIB), ('audio', 20 * MIB), ('photo', 10 * MIB), ('pdf', 20 * MIB), ('text', 80_000)])
async def test_download_limit_and_policy_per_external_request(download_setup, monkeypatch, kind, limit):
    item, calls, state = download_setup
    state['metadata']['file_size'] = limit
    seen = []
    original = ServerPolicyEngine.authorize

    def observe(self, descriptor, call, context):
        seen.append((descriptor.required_scope, descriptor.external_effect, context.actor))
        return original(self, descriptor, call, context)

    monkeypatch.setattr(ServerPolicyEngine, 'authorize', observe)
    assert await download_media(item, TelegramMedia(kind=kind, file_id='id', file_size=limit)) == b'content'
    assert calls == [('get_file', 'id'), ('download_file', FILE_PATH, limit)]
    assert seen == [('telegram.download', True, 'telegram:integration')] * 2


async def test_get_file_size_precheck_stops_before_downloading(download_setup):
    item, calls, state = download_setup
    state['metadata']['file_size'] = 10 * MIB + 1
    with pytest.raises(TelegramMediaError) as exc:
        await download_media(item, TelegramMedia(kind='photo', file_id='id'))
    assert exc.value.code == 'MEDIA_TOO_LARGE' and calls == [('get_file', 'id')]


@pytest.mark.parametrize('kind,file_id', [('unsupported', 'id'), ('unknown', 'id'), ('voice', ''), ('voice', 'x' * 513)])
async def test_unsupported_or_malformed_media_never_downloads(download_setup, kind, file_id):
    item, calls, _ = download_setup
    with pytest.raises(TelegramMediaError):
        await download_media(item, TelegramMedia(kind=kind, file_id=file_id))
    assert not calls


@pytest.mark.parametrize('field,value', [('enabled', False), ('encrypted_token', None), ('owner_telegram_id', None), ('deleted_at', 'deleted')])
async def test_inactive_integration_no_download(download_setup, field, value):
    item, calls, _ = download_setup
    setattr(item, field, value)
    with pytest.raises(TelegramMediaError):
        await download_media(item, TelegramMedia(kind='voice', file_id='id'))
    assert not calls


async def test_policy_denial_stops_before_network(download_setup, monkeypatch):
    item, calls, _ = download_setup

    def deny(self, descriptor, call, context):
        raise PolicyDenied('No media permission')

    monkeypatch.setattr(ServerPolicyEngine, 'authorize', deny)
    with pytest.raises(PolicyDenied):
        await download_media(item, TelegramMedia(kind='voice', file_id='id'))
    assert not calls


@pytest.mark.parametrize('content,valid', [('😀' * 20_000, True), ('a' * 20_001, False), (b'\xff\xfe', False)])
async def test_utf8_and_text_character_limit(download_setup, content, valid):
    item, _, state = download_setup
    state['data'] = content.encode('utf-8') if isinstance(content, str) else content
    state['metadata'].pop('file_size')
    media = TelegramMedia(kind='text', file_id='id')
    if valid:
        assert await download_media(item, media) == state['data']
    else:
        with pytest.raises(TelegramMediaError) as exc:
            await download_media(item, media)
        assert exc.value.code == ('MEDIA_TOO_LARGE' if isinstance(content, str) else 'MEDIA_TEXT_INVALID')


async def test_helper_uses_real_bounded_transport_in_memory(monkeypatch):
    item = TelegramIntegration(id='integration', owner_id='owner', bot_id=1, bot_username='test',
        bot_name='Test', business_capable=True, encrypted_token=encrypt_secret(TOKEN),
        enabled=True, owner_telegram_id=111)
    calls = []
    stream = Stream([b'a' * 40_000, b'b' * 40_000, b'c', b'never read'])

    def handler(request):
        calls.append(request.method)
        if request.method == 'POST':
            return httpx.Response(200, json={'ok': True, 'result': {'file_path': 'documents/file.txt'}})
        return httpx.Response(200, stream=stream)

    monkeypatch.setattr(service, 'TelegramClient', lambda token: TelegramClient(token, httpx.MockTransport(handler)))
    with pytest.raises(TelegramMediaError) as exc:
        await download_media(item, TelegramMedia(kind='text', file_id='id'))
    assert exc.value.code == 'MEDIA_TOO_LARGE'
    assert stream.read == 3 and stream.closed and calls == ['POST', 'GET']


@pytest.mark.parametrize('metadata', [{}, {'file_path': 1}, {'file_path': FILE_PATH, 'file_size': -1}, {'file_path': FILE_PATH, 'file_size': True}])
async def test_invalid_get_file_metadata_no_byte_download(download_setup, metadata):
    item, calls, state = download_setup
    state['metadata'] = metadata
    with pytest.raises(TelegramMediaError) as exc:
        await download_media(item, TelegramMedia(kind='voice', file_id='id'))
    assert exc.value.code == 'MEDIA_INVALID' and calls == [('get_file', 'id')]


async def test_second_external_policy_check_can_stop_byte_download(download_setup, monkeypatch):
    item, calls, _ = download_setup
    count = 0
    original = ServerPolicyEngine.authorize

    def deny_second(self, descriptor, call, context):
        nonlocal count
        count += 1
        if count == 2:
            raise PolicyDenied('Download denied')
        return original(self, descriptor, call, context)

    monkeypatch.setattr(ServerPolicyEngine, 'authorize', deny_second)
    with pytest.raises(PolicyDenied):
        await download_media(item, TelegramMedia(kind='voice', file_id='id'))
    assert calls == [('get_file', 'id')]


@pytest.mark.parametrize('method', ['get_file', 'download_file'])
@pytest.mark.parametrize('code,expected', [('file_too_large', 'MEDIA_TOO_LARGE'), ('network_error', 'MEDIA_INVALID'), ('timeout', 'MEDIA_INVALID'), (404, 'MEDIA_INVALID'), ('invalid_file_path', 'MEDIA_INVALID')])
async def test_telegram_failures_map_to_honest_media_errors(download_setup, monkeypatch, method, code, expected):
    item, _, _ = download_setup
    transport = service.TelegramClient

    async def fail(*_args):
        try:
            raise RuntimeError(f'https://api.telegram.org/file/bot{TOKEN}/{FILE_PATH}')
        except RuntimeError:
            raise TelegramError(code) from None

    monkeypatch.setattr(transport, method, fail)
    with pytest.raises(TelegramMediaError) as exc:
        await download_media(item, TelegramMedia(kind='voice', file_id='id'))
    assert exc.value.code == expected
    formatted = ''.join(traceback.format_exception(exc.value))
    assert TOKEN not in formatted and FILE_PATH not in formatted
    assert 'api.telegram.org' not in formatted


@pytest.mark.parametrize('sticker,mime,emoji', [
    ({'file_id': 'static', 'emoji': '😂'}, 'image/webp', '😂'),
    ({'file_id': 'animated', 'is_animated': True, 'emoji': 'x' * 40}, 'application/x-tgsticker', 'x' * 16),
    ({'file_id': 'video', 'is_video': True}, 'video/webm', None),
])
def test_business_sticker_metadata_is_bounded(sticker, mime, emoji):
    assert asdict(parse_business_media({'sticker': sticker})) == {'kind': 'sticker', 'file_id': sticker['file_id'], 'file_size': None, 'mime_type': mime, 'filename': None, 'emoji': emoji}
    assert parse_business_media({'sticker': {'file_id': 'bad id'}}) is None


def test_only_static_webp_sticker_previews_and_animated_formats_stay_refused():
    assert content_type('sticker', b'RIFF\x00\x00\x00\x00WEBPVP8 ') == 'image/webp'
    for data in (b'\x1f\x8b\x08 gzip-tgs', b'\x89PNG\r\n\x1a\n'):
        with pytest.raises(Exception, match='TELEGRAM_MEDIA_UNSUPPORTED'):
            content_type('sticker', data)
