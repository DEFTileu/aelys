from __future__ import annotations

import tempfile
from collections.abc import Iterator

import pytest
from app.english.speech import MAX_BYTES, read_audio
from fastapi import HTTPException
from starlette import formparsers
from starlette.requests import Request

BOUNDARY = b"aelys-audio-boundary"


def multipart_body(*parts: tuple[str, bytes, str | None]) -> bytes:
    chunks: list[bytes] = []
    for name, data, content_type in parts:
        headers = [f'Content-Disposition: form-data; name="{name}"']
        if content_type is not None:
            headers[0] += '; filename="upload.bin"'
            headers.append(f"Content-Type: {content_type}")
        chunks.extend((b"--" + BOUNDARY + b"\r\n", "\r\n".join(headers).encode(), b"\r\n\r\n", data, b"\r\n"))
    chunks.extend((b"--" + BOUNDARY + b"--\r\n",))
    return b"".join(chunks)


def request_for(body: bytes, *, chunk_size: int = 64 * 1024, content_type: str | None = None) -> Request:
    chunks: Iterator[bytes] = iter(body[i:i + chunk_size] for i in range(0, len(body), chunk_size))

    async def receive():
        try:
            return {"type": "http.request", "body": next(chunks), "more_body": True}
        except StopIteration:
            return {"type": "http.request", "body": b"", "more_body": False}

    return Request({
        "type": "http",
        "method": "POST",
        "path": "/api/v1/english/speech/transcribe",
        "headers": [(b"content-type", (content_type or f"multipart/form-data; boundary={BOUNDARY.decode()}").encode())],
    }, receive)


@pytest.mark.asyncio
async def test_multipart_audio_over_one_megabyte_stays_in_memory(monkeypatch):
    def forbidden_tempfile(*args, **kwargs):
        raise AssertionError("multipart parsing must not create temporary files")

    monkeypatch.setattr(tempfile, "SpooledTemporaryFile", forbidden_tempfile)
    monkeypatch.setattr(formparsers, "SpooledTemporaryFile", forbidden_tempfile)
    data = b"a" * (1024 * 1024 + 1)

    mime, parsed = await read_audio(request_for(multipart_body(("audio", data, "audio/webm"))))

    assert mime == "audio/webm"
    assert parsed == data


@pytest.mark.asyncio
async def test_valid_multipart_audio_with_boundaries_split_across_chunks():
    data = b"split across parser chunks"

    mime, parsed = await read_audio(request_for(multipart_body(("audio", data, "audio/webm")), chunk_size=1))

    assert mime == "audio/webm"
    assert parsed == data


@pytest.mark.asyncio
async def test_multipart_audio_over_limit_is_rejected_as_413():
    body = multipart_body(("audio", b"a" * (MAX_BYTES + 1), "audio/webm"))

    with pytest.raises(HTTPException) as raised:
        await read_audio(request_for(body))

    assert raised.value.status_code == 413
    assert isinstance(raised.value.detail, dict)
    assert raised.value.detail["code"] == "AUDIO_TOO_LARGE"


@pytest.mark.asyncio
async def test_multipart_missing_audio_is_rejected_as_empty():
    body = multipart_body(("other", b"x", "audio/webm"))

    with pytest.raises(HTTPException) as raised:
        await read_audio(request_for(body))

    assert raised.value.status_code == 422
    assert isinstance(raised.value.detail, dict)
    assert raised.value.detail["code"] == "AUDIO_EMPTY"


@pytest.mark.asyncio
async def test_multipart_duplicate_parts_are_rejected():
    body = multipart_body(("audio", b"first", "audio/webm"), ("audio", b"second", "audio/webm"))

    with pytest.raises(HTTPException) as raised:
        await read_audio(request_for(body))

    assert raised.value.status_code == 422
    assert isinstance(raised.value.detail, dict)
    assert raised.value.detail["code"] == "AUDIO_INVALID"


@pytest.mark.asyncio
async def test_malformed_multipart_is_rejected_without_logging_audio(caplog):
    sentinel = b"AUDIO_PRIVATE_SENTINEL"
    body = b"--" + BOUNDARY + b"\r\nnot-a-header\r\n\r\n" + sentinel

    with pytest.raises(HTTPException) as raised:
        await read_audio(request_for(body))

    assert raised.value.status_code == 422
    assert isinstance(raised.value.detail, dict)
    assert raised.value.detail["code"] == "AUDIO_INVALID"
    assert sentinel.decode() not in caplog.text
    assert not caplog.records


@pytest.mark.asyncio
async def test_multipart_missing_final_delimiter_is_rejected():
    body = multipart_body(("audio", b"partial upload", "audio/webm"))[:-len(BOUNDARY) - 6]

    with pytest.raises(HTTPException) as raised:
        await read_audio(request_for(body))

    assert raised.value.status_code == 422
    assert isinstance(raised.value.detail, dict)
    assert raised.value.detail["code"] == "AUDIO_INVALID"


@pytest.mark.asyncio
async def test_multipart_request_overhead_is_bounded():
    body = multipart_body(("other", b"x" * (MAX_BYTES + 64 * 1024 + 1), None))

    with pytest.raises(HTTPException) as raised:
        await read_audio(request_for(body))

    assert raised.value.status_code == 413
    assert isinstance(raised.value.detail, dict)
    assert raised.value.detail["code"] == "AUDIO_TOO_LARGE"
