"""Real loopback HTTP checks for provider subscription cleanup, without credentials."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest
from app.ai.api import HttpxTransport
from app.ai.errors import RunCancelled


@asynccontextmanager
async def provider_server(
    *,
    frames: int = 0,
    send_headers: bool = True,
    received: asyncio.Event | None = None,
    completion_body: bytes | None = None,
    frame_payload: bytes = b'{"text":"synthetic"}',
):
    disconnected = asyncio.Event()
    handlers: set[asyncio.Task] = set()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        current = asyncio.current_task()
        handlers.add(current)
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            length = next(
                (
                    int(line.split(b":", 1)[1])
                    for line in headers.split(b"\r\n")
                    if line.lower().startswith(b"content-length:")
                ),
                0,
            )
            await reader.readexactly(length)
            if received is not None:
                received.set()
            body = b"".join(b"data: " + frame_payload + b"\n\n" for _ in range(frames))
            if frames:
                body += b"data: [DONE]\n\n"
            if send_headers:
                wire = (
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                    + body
                )
                if completion_body is not None:
                    wire = (
                        f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(completion_body)}\r\nConnection: close\r\n\r\n".encode()
                        + completion_body
                    )
                writer.write(wire)
                await writer.drain()
            await reader.read()
            disconnected.set()
        finally:
            disconnected.set()
            writer.close()
            await writer.wait_closed()
            handlers.discard(current)

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        async with server:
            yield f"http://127.0.0.1:{port}/synthetic-provider", disconnected
    finally:
        for task in tuple(handlers):
            task.cancel()
        await asyncio.gather(*handlers, return_exceptions=True)


def track_children(monkeypatch):
    create_task = asyncio.create_task
    children = []

    def tracked(coroutine, **kwargs):
        task = create_task(coroutine, **kwargs)
        children.append(task)
        return task

    monkeypatch.setattr(asyncio, "create_task", tracked)
    return create_task, children


async def collect(transport, url):
    return [event async for event in transport.stream(url, headers={}, json={})]


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [b"[]", b"null"])
async def test_invalid_provider_event_shape_fails_instead_of_completing(payload):
    async with provider_server(frames=1, frame_payload=payload) as (url, disconnected):
        with pytest.raises(TypeError, match="^provider response invalid$"):
            await asyncio.wait_for(collect(HttpxTransport(), url), 1)
        await asyncio.wait_for(disconnected.wait(), 1)


async def clean_tasks(*tasks):
    for task in tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def call_transport(transport, url, method):
    if method == "post":
        return await transport.post(url, headers={}, json={})
    return await collect(transport, url)


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["stream", "post"])
@pytest.mark.parametrize("source", ["local", "durable"])
async def test_already_cancelled_runs_do_not_send_provider_requests(
    monkeypatch, method, source
):
    create_task, children = track_children(monkeypatch)
    cancel, received = asyncio.Event(), asyncio.Event()
    if source == "local":
        cancel.set()

    async def durable_check():
        return source == "durable"

    async with provider_server(received=received) as (url, _):
        consumer = create_task(
            call_transport(HttpxTransport(cancel, durable_check), url, method)
        )
        try:
            if method == "post":
                with pytest.raises(RunCancelled):
                    await asyncio.wait_for(consumer, 1)
            else:
                assert await asyncio.wait_for(consumer, 1) == []
            assert not received.is_set()
            assert all(task.done() for task in children)
        finally:
            await clean_tasks(consumer, *children)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method,send_headers", [("stream", False), ("post", False), ("post", True)]
)
@pytest.mark.parametrize("source", ["local", "durable"])
async def test_cancel_closes_pending_headers_or_completion_body(
    monkeypatch, method, send_headers, source
):
    create_task, children = track_children(monkeypatch)
    received, local_cancel, durable_cancel = (
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
    )

    async def durable_check():
        return durable_cancel.is_set()

    async with provider_server(send_headers=send_headers, received=received) as (
        url,
        disconnected,
    ):
        consumer = create_task(
            call_transport(HttpxTransport(local_cancel, durable_check), url, method)
        )
        try:
            await asyncio.wait_for(received.wait(), 2)
            (local_cancel if source == "local" else durable_cancel).set()
            if method == "post":
                with pytest.raises(RunCancelled):
                    await asyncio.wait_for(asyncio.shield(consumer), 1)
            else:
                assert await asyncio.wait_for(asyncio.shield(consumer), 1) == []
            assert all(task.done() for task in children)
            await asyncio.wait_for(disconnected.wait(), 1)
        finally:
            await clean_tasks(consumer, *children)


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["local", "durable"])
async def test_cancellation_finishes_and_joins_all_waiters(monkeypatch, source):
    create_task, children = track_children(monkeypatch)
    cancel = asyncio.Event()
    checked = asyncio.Event()
    durable_cancel = asyncio.Event()
    received = asyncio.Event()

    async def durable_check():
        checked.set()
        return durable_cancel.is_set()

    async with provider_server(received=received) as (url, disconnected):
        consumer = create_task(collect(HttpxTransport(cancel, durable_check), url))
        try:
            await asyncio.wait_for(checked.wait(), 2)
            await asyncio.wait_for(received.wait(), 2)
            (cancel if source == "local" else durable_cancel).set()
            assert await asyncio.wait_for(asyncio.shield(consumer), 1) == []
            assert all(task.done() for task in children)
            await asyncio.wait_for(disconnected.wait(), 1)
        finally:
            await clean_tasks(consumer, *children)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method,send_headers",
    [("stream", True), ("stream", False), ("post", False), ("post", True)],
)
async def test_outer_cancel_joins_all_provider_waiters(
    monkeypatch, method, send_headers
):
    create_task, children = track_children(monkeypatch)
    checked = asyncio.Event()
    received = asyncio.Event()

    async def durable_check():
        checked.set()
        return False

    async with provider_server(received=received, send_headers=send_headers) as (
        url,
        disconnected,
    ):
        consumer = create_task(
            call_transport(HttpxTransport(asyncio.Event(), durable_check), url, method)
        )
        try:
            await asyncio.wait_for(checked.wait(), 2)
            await asyncio.wait_for(received.wait(), 2)
            consumer.cancel()
            with pytest.raises(asyncio.CancelledError):
                await consumer
            assert all(task.done() for task in children)
            await asyncio.wait_for(disconnected.wait(), 1)
        finally:
            await clean_tasks(consumer, *children)


@pytest.mark.asyncio
async def test_completion_post_returns_json_and_joins_waiters(monkeypatch):
    create_task, children = track_children(monkeypatch)

    async def durable_check():
        return False

    async with provider_server(completion_body=b'{"id":"synthetic"}') as (
        url,
        disconnected,
    ):
        consumer = create_task(
            call_transport(HttpxTransport(asyncio.Event(), durable_check), url, "post")
        )
        try:
            response = await asyncio.wait_for(consumer, 1)
            assert response.status == 200 and response.body == {"id": "synthetic"}
            assert all(task.done() for task in children)
            await asyncio.wait_for(disconnected.wait(), 1)
        finally:
            await clean_tasks(consumer, *children)


@pytest.mark.asyncio
async def test_durable_polling_does_not_run_for_every_sse_line(record_property):
    checks = 0

    async def durable_check():
        nonlocal checks
        checks += 1
        return False

    async with provider_server(frames=20) as (url, disconnected):
        events = await asyncio.wait_for(
            collect(HttpxTransport(cancel_check=durable_check), url), 2
        )
        assert len(events) == 20
        record_property("durable_checks", checks)
        record_property("sse_frames", len(events))
        assert checks <= 8, (
            f"durable status lookup was repeated {checks} times for 20 buffered frames"
        )
        await asyncio.wait_for(disconnected.wait(), 1)


@pytest.mark.asyncio
async def test_durable_check_failure_is_not_silently_reported_as_normal_eof(
    monkeypatch,
):
    create_task, children = track_children(monkeypatch)
    received, fail = asyncio.Event(), asyncio.Event()

    async def durable_check():
        if fail.is_set():
            raise ValueError("api_key=synthetic-sensitive-detail")
        return False

    async with provider_server(received=received) as (url, disconnected):
        consumer = create_task(collect(HttpxTransport(cancel_check=durable_check), url))
        try:
            await asyncio.wait_for(received.wait(), 2)
            fail.set()
            with pytest.raises(
                RuntimeError, match="^provider cancellation unavailable$"
            ):
                await asyncio.wait_for(consumer, 1)
            assert all(task.done() for task in children)
            await asyncio.wait_for(disconnected.wait(), 1)
        finally:
            await clean_tasks(consumer, *children)


@pytest.mark.asyncio
async def test_consumer_closing_generator_closes_http_subscription(monkeypatch):
    _, children = track_children(monkeypatch)

    async def durable_check():
        return False

    async with provider_server(frames=20) as (url, disconnected):
        stream = HttpxTransport(asyncio.Event(), durable_check).stream(
            url, headers={}, json={}
        )
        try:
            assert await asyncio.wait_for(anext(stream), 1) == {"text": "synthetic"}
            assert all(task.done() for task in children)
            await stream.aclose()
            await asyncio.wait_for(disconnected.wait(), 1)
        finally:
            await stream.aclose()
            await clean_tasks(*children)
