"""Owner-scoped lookup shared by the HTTP routes and the services (kept out of api.py to avoid an import cycle)."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession


async def owner_obj(model: type[Any], item_id: str, owner_id: str, db: AsyncSession):
    item = await db.get(model, item_id)
    if not item or item.owner_id != owner_id or item.deleted_at is not None: raise HTTPException(404, detail={"code":"NOT_FOUND","message":"Resource not found"})
    return item
