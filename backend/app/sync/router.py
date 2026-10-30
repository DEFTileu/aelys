"""FastAPI router factory for ``/api/v1/sync``.

The foundation app supplies ``owner_id`` and ``SyncService`` through its auth
dependency.  Keeping the factory injectable avoids coupling sync to an auth
implementation that is not present in this repository slice yet.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from .errors import SyncException
from .service import SyncService


def build_router(
    service: SyncService,
    owner_id_dependency: Callable[..., str],
):
    router = APIRouter(prefix="/api/v1/sync", tags=["sync"])

    def error(exc: SyncException) -> HTTPException:
        return HTTPException(
            status_code=exc.status_code,
            detail={"error": {"code": exc.code.value, "message": exc.message, "details": exc.details}},
        )

    @router.post("/push")
    async def push(body: Mapping[str, Any], owner_id: str = Depends(owner_id_dependency)):
        try:
            result = service.push(owner_id, body)
            return {
                "results": [
                    {
                        "operation_id": item.operation_id,
                        "status": item.status.value,
                        "version": item.version,
                        "cursor": item.cursor,
                        "error_code": item.error_code.value if item.error_code else None,
                        "message": item.message,
                        "server_record": item.server_record,
                        "conflict_id": item.conflict_id,
                        "branches": item.branches,
                    }
                    for item in result.results
                ],
                "server_cursor": result.server_cursor,
            }
        except SyncException as exc:
            raise error(exc) from exc

    @router.get("/pull")
    async def pull(
        device_id: str,
        cursor: str | None = None,
        limit: int = Query(200, ge=1, le=200),
        owner_id: str = Depends(owner_id_dependency),
    ):
        try:
            result = service.pull(owner_id, device_id, cursor, limit)
            return {"changes": result.changes, "next_cursor": result.next_cursor, "has_more": result.has_more}
        except SyncException as exc:
            raise error(exc) from exc

    @router.get("/bootstrap")
    async def bootstrap(
        device_id: str,
        scope: str | None = None,
        page_token: str | None = None,
        limit: int = Query(200, ge=1, le=200),
        owner_id: str = Depends(owner_id_dependency),
    ):
        try:
            result = service.bootstrap(owner_id, device_id, scope, page_token, limit)
            return {
                "records": result.records,
                "cursor": result.cursor,
                "next_page_token": result.next_page_token,
                "has_more": result.has_more,
            }
        except SyncException as exc:
            raise error(exc) from exc

    @router.get("/status")
    async def status(device_id: str, owner_id: str = Depends(owner_id_dependency)):
        try:
            value = service.status(owner_id, device_id)
            return {
                "device_id": value.device_id,
                "acknowledged_seq": value.acknowledged_seq,
                "current_commit_seq": value.current_commit_seq,
                "compaction_watermark": value.compaction_watermark,
                "pending_operations": value.pending_operations,
                "reset_required": value.reset_required,
            }
        except SyncException as exc:
            raise error(exc) from exc

    return router
