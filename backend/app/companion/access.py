"""Fail-closed rights for the ESP32 companion: a paired board may reach only the routes listed here."""
from __future__ import annotations

from app.core.models import Device
from fastapi import HTTPException, Request
from starlette.routing import replace_params

# (method, full route template); later companion tasks extend this set and nothing else.
COMPANION_ALLOWED: frozenset[tuple[str, str]] = frozenset({
    ("GET", "/api/v1/companion/snapshot"),
    ("POST", "/api/v1/companion/actions"),
})


def _route_template(request: Request) -> str | None:
    """Full matched template, e.g. /api/v1/devices/{device_id}/revoke.

    FastAPI >= 0.16x leaves route.path without the include_router prefix, older versions include it, so the prefix
    is recovered from the real URL: it is whatever precedes the matched route's filled-in path.
    """
    scope = request.scope
    route = scope.get("route")
    template = getattr(route, "path_format", None)
    if route is None or not template:
        return None
    filled, _ = replace_params(template, route.param_convertors, dict(scope.get("path_params", {})))
    path = scope["path"].removeprefix(scope.get("root_path", ""))
    return path[: len(path) - len(filled)] + template if path.endswith(filled) else None


def ensure_companion_allowed(request: Request, device: Device | None) -> None:
    if device is None or device.platform != "companion":
        return
    if (request.method, _route_template(request)) not in COMPANION_ALLOWED:  # unresolved route -> None -> denied
        raise HTTPException(403, detail={"code": "DEVICE_SCOPE_DENIED", "message": "This device may not use this endpoint"})
