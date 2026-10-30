"""Cancellable provider I/O; helpers never outlive a network wait."""

from __future__ import annotations

import asyncio
import json as jsonlib
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any, TypeVar

import httpx

from .errors import RunCancelled
from .providers import HttpResponse

T = TypeVar("T")


class HttpxTransport:
    def __init__(
        self,
        cancel_event: asyncio.Event | None = None,
        cancel_check: Callable[[], Awaitable[bool]] | None = None,
    ):
        self._cancel_event = cancel_event
        self._cancel_check = cancel_check
        self._next_cancel_poll = 0.0

    async def _check_cancelled(self) -> None:
        if self._cancel_event and self._cancel_event.is_set():
            raise RunCancelled("run cancelled")
        now = asyncio.get_running_loop().time()
        if self._cancel_check and now >= self._next_cancel_poll:
            self._next_cancel_poll = now + 0.25
            try:
                cancelled = await self._cancel_check()
            except Exception:  # noqa: BLE001 -- storage callback details must not escape.
                raise RuntimeError("provider cancellation unavailable") from None
            if cancelled:
                if self._cancel_event:
                    self._cancel_event.set()
                raise RunCancelled("run cancelled")
        if self._cancel_event and self._cancel_event.is_set():
            raise RunCancelled("run cancelled")

    async def _wait_for_durable_cancellation(self) -> None:
        while True:
            delay = max(0, self._next_cancel_poll - asyncio.get_running_loop().time())
            await asyncio.sleep(delay)
            await self._check_cancelled()

    async def _await_or_cancel(self, operation: Callable[[], Awaitable[T]]) -> T:
        # Pre-check before constructing the I/O coroutine: already cancelled
        # runs must not send a request or leave an unawaited coroutine behind.
        await self._check_cancelled()

        async def perform() -> T:
            return await operation()

        work = asyncio.create_task(perform())
        waiters: list[asyncio.Task[Any]] = [work]
        watchers: list[asyncio.Task[Any]] = []
        try:
            if self._cancel_event:
                watchers.append(asyncio.create_task(self._cancel_event.wait()))
            if self._cancel_check:
                watchers.append(
                    asyncio.create_task(self._wait_for_durable_cancellation())
                )
            waiters.extend(watchers)
            done, _ = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
            for watcher in watchers:
                if watcher in done:
                    watcher.result()
                    raise RunCancelled("run cancelled")
            return work.result()
        finally:
            # Drain before yielding to API code using the same DB session, on
            # cancellation, normal return, exception and consumer disconnect.
            for task in waiters:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*waiters, return_exceptions=True)

    async def post(
        self, url: str, *, headers: Mapping[str, str], json: Mapping[str, Any]
    ) -> HttpResponse:
        try:
            async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
                response = await self._await_or_cancel(
                    lambda: client.post(url, headers=headers, json=json)
                )
            try:
                body = response.json()
            except ValueError:
                body = {}
            return HttpResponse(response.status_code, body)
        except httpx.HTTPError as exc:
            raise RuntimeError("provider transport unavailable") from exc

    async def stream(
        self, url: str, *, headers: Mapping[str, str], json: Mapping[str, Any]
    ) -> AsyncIterator[Mapping[str, Any]]:
        try:
            async with httpx.AsyncClient(timeout=120, follow_redirects=False) as client:
                request = client.build_request("POST", url, headers=headers, json=json)
                response = await self._await_or_cancel(
                    lambda: client.send(request, stream=True)
                )
                try:
                    if response.status_code >= 400:
                        raise RuntimeError(
                            f"provider returned status {response.status_code}"
                        )
                    lines = response.aiter_lines().__aiter__()
                    while True:
                        try:
                            line = await self._await_or_cancel(lambda: anext(lines))
                        except StopAsyncIteration:
                            break
                        if not line.startswith("data:"):
                            continue
                        value = line[5:].strip()
                        if value == "[DONE]":
                            break
                        try:
                            item = jsonlib.loads(value)
                        except ValueError:
                            continue
                        if not isinstance(item, dict):
                            raise TypeError("provider response invalid")
                        yield item
                finally:
                    await response.aclose()
        except RunCancelled:
            # Execution checks the same event/durable state after stream EOF
            # and emits the existing typed ai.run.cancelled event.
            return
        except httpx.HTTPError as exc:
            raise RuntimeError("provider transport unavailable") from exc
