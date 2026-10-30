"""AI run lifecycle, cancellation, duplicate-safe events, and SSE formatting."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from .errors import RunCancelled, redact_error
from .models import RunEvent, RunStatus


class EventLog:
    def __init__(self):
        self._events: dict[UUID, list[RunEvent]] = {}
        self._event_ids: dict[UUID, set[str]] = {}
        self._locks: dict[UUID, asyncio.Lock] = {}

    async def append(self, event: RunEvent) -> RunEvent:
        lock = self._locks.setdefault(event.run_id, asyncio.Lock())
        async with lock:
            ids = self._event_ids.setdefault(event.run_id, set())
            if event.event_id in ids:
                return next(e for e in self._events[event.run_id] if e.event_id == event.event_id)
            events = self._events.setdefault(event.run_id, [])
            sequence = len(events) + 1
            normalized = RunEvent(event.run_id, event.event_type, dict(event.payload), sequence, event.event_id, event.created_at)
            ids.add(event.event_id)
            events.append(normalized)
            return normalized

    def since(self, run_id: UUID, sequence: int = 0) -> tuple[RunEvent, ...]:
        return tuple(e for e in self._events.get(run_id, ()) if e.sequence > sequence)


class SSEFormatter:
    @staticmethod
    def format(event: RunEvent) -> str:
        return f"event: {event.event_type}\nid: {event.sequence}\ndata: {json.dumps({'run_id': str(event.run_id), **event.payload}, separators=(',', ':'), ensure_ascii=False)}\n\n"


@dataclass
class _Run:
    status: RunStatus
    cancel: asyncio.Event
    task: asyncio.Task[None] | None = None


Runner = Callable[[UUID, asyncio.Event, Callable[[str, Mapping[str, Any], str | None], Awaitable[None]]], Awaitable[None]]


class AIRunManager:
    def __init__(self, events: EventLog | None = None):
        self.events = events or EventLog()
        self._runs: dict[UUID, _Run] = {}

    async def _emit(self, run_id: UUID, event_type: str, payload: Mapping[str, Any], event_id: str | None = None) -> None:
        await self.events.append(RunEvent(run_id, event_type, dict(payload), 0, event_id or str(uuid4())))

    async def _emit_callback(
        self,
        run_id: UUID,
        event_type: str,
        payload: Mapping[str, Any],
        event_id: str | None = None,
    ) -> None:
        await self._emit(run_id, event_type, payload, event_id)

    async def start(self, runner: Runner) -> UUID:
        run_id = uuid4()
        state = _Run(RunStatus.QUEUED, asyncio.Event())
        self._runs[run_id] = state

        async def execute() -> None:
            state.status = RunStatus.RUNNING
            await self._emit(run_id, "ai.run.started", {})
            try:
                await runner(run_id, state.cancel, self._emit_callback_for(run_id))
                if state.cancel.is_set():
                    raise RunCancelled("run cancelled")
                state.status = RunStatus.COMPLETED
                await self._emit(run_id, "ai.run.completed", {})
            except asyncio.CancelledError:
                state.cancel.set()
                state.status = RunStatus.CANCELLED
                await self._emit(run_id, "ai.run.cancelled", {})
            except RunCancelled:
                state.status = RunStatus.CANCELLED
                await self._emit(run_id, "ai.run.cancelled", {})
            except Exception as exc:  # noqa: BLE001 - runner failures are recorded without raw exception details
                state.status = RunStatus.FAILED
                await self._emit(run_id, "ai.run.failed", {"code": "AI_ERROR", "message": redact_error(exc)})

        state.task = asyncio.create_task(execute())
        return run_id

    async def cancel(self, run_id: UUID) -> None:
        state = self._runs[run_id]
        state.cancel.set()

    def _emit_callback_for(
        self, run_id: UUID
    ) -> Callable[[str, Mapping[str, Any], str | None], Awaitable[None]]:
        async def emit(
            event_type: str,
            payload: Mapping[str, Any],
            event_id: str | None = None,
        ) -> None:
            await self._emit(run_id, event_type, payload, event_id)

        return emit

    def status(self, run_id: UUID) -> RunStatus:
        return self._runs[run_id].status

    async def stream(self, run_id: UUID, after_sequence: int = 0) -> AsyncIterator[str]:
        next_sequence = after_sequence
        while True:
            events = self.events.since(run_id, next_sequence)
            for event in events:
                next_sequence = event.sequence
                yield SSEFormatter.format(event)
            state = self._runs[run_id]
            if state.status in (RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED) and not self.events.since(run_id, next_sequence):
                return
            await asyncio.sleep(0)
