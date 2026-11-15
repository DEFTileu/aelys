"""App hint stream: tells an owner's signed-in apps which collections changed, never what changed."""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator

from app.companion.hub import hub
from app.core.db import get_db
from app.core.security import bearer_scheme, current_principal, decode_token
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(tags=["changes"])

HEARTBEAT_SECONDS = 15.0  # keeps proxies from cutting an idle stream
MAX_STREAM_SECONDS = 240.0  # reconnecting re-checks the session; under the native 300 s stream timeout


async def hint_stream(owner_id: str, lifetime: float) -> AsyncIterator[str]:
    subscriber, unsubscribe = hub.subscribe_hints(owner_id)
    deadline = time.monotonic() + lifetime
    try:
        yield ": ready\n\n"
        while (left := deadline - time.monotonic()) > 0:
            try:
                await asyncio.wait_for(subscriber.wake.wait(), min(HEARTBEAT_SECONDS, left))
            except TimeoutError:
                yield ": ping\n\n"
                continue
            yield f"event: changes.hint\ndata: {json.dumps({'collections': sorted(subscriber.take())})}\n\n"
    finally:
        unsubscribe()


@router.get("/changes", response_class=StreamingResponse, responses={200: {"content": {"text/event-stream": {}}}})
async def changes(principal=Depends(current_principal), credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    expires = int(decode_token(credentials.credentials if credentials else "")["exp"])
    await db.close()  # auth is done; a long-lived stream must not hold a pooled connection
    lifetime = max(0.0, min(MAX_STREAM_SECONDS, expires - time.time()))  # an expired token stops getting hints
    return StreamingResponse(hint_stream(user.id, lifetime), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
