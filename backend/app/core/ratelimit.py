"""In-process sliding-window rate limits for authentication endpoints.

State is per server process, which fits the single-owner, single-instance deployment. A multi-instance
deployment needs a shared store; until then each instance enforces its own limits (stricter overall, never looser).
Per-identity limits slow guessing against one account or pairing; per-address limits slow spraying across many.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from .config import get_settings

Limit = tuple[int, int]  # (hits, window seconds)
_hits: dict[str, deque[float]] = defaultdict(deque)
_MAX_KEYS = 20_000


def reset() -> None:
    _hits.clear()


def client_address(request: Request) -> str:
    """The socket peer, or the Nth address from the right of X-Forwarded-For when proxies are trusted."""
    hops = get_settings().trusted_proxy_count
    if hops > 0:
        forwarded = [part.strip() for part in request.headers.get("x-forwarded-for", "").split(",") if part.strip()]
        if len(forwarded) >= hops:
            return forwarded[-hops]
    return request.client.host if request.client else "unknown"


def _record(key: str, limit: Limit, now: float) -> int:
    """Count one hit; return seconds to wait when over the limit, else 0."""
    hits, window = limit
    bucket = _hits[key]
    while bucket and bucket[0] <= now - window:
        bucket.popleft()
    if len(bucket) >= hits:
        return max(1, int(bucket[0] + window - now) + 1)
    bucket.append(now)
    return 0


def _evict(now: float) -> None:
    if len(_hits) < _MAX_KEYS:
        return
    for key in [key for key, bucket in _hits.items() if not bucket or bucket[-1] < now - 3600]:
        del _hits[key]


def enforce(request: Request, bucket: str, per_address: Limit, identity: str | None = None, per_identity: Limit | None = None) -> None:
    """Raise 429 with Retry-After once the caller or the targeted identity exceeds its window."""
    if not get_settings().rate_limit_enabled:
        return
    now = time.monotonic()
    _evict(now)
    waits = [_record(f"{bucket}:ip:{client_address(request)}", per_address, now)]
    if identity is not None and per_identity is not None:
        waits.append(_record(f"{bucket}:id:{identity}", per_identity, now))
    wait = max(waits)
    if wait:
        raise HTTPException(429, detail={"code": "RATE_LIMITED", "message": f"Too many attempts; retry in {wait} seconds"}, headers={"Retry-After": str(wait)})
