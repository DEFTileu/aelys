from __future__ import annotations
import uuid
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from .core.api import router as core_router
from .domains.api import router as domain_router
from .sync.api import router as sync_router
from .ai.api import router as ai_router
from .agents.api import router as agents_router
from .automation.api import router as automation_router
from .core.db import Base, engine
from .core import models  # noqa: F401

app = FastAPI(title="Aelys API", version="0.1.0", openapi_url="/api/v1/openapi.json")

@app.middleware("http")
async def request_id(request: Request, call_next):
    request_id = str(uuid.uuid4())
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response

@app.exception_handler(ValueError)
async def value_error(_: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"error":{"code":"VALIDATION_ERROR","message":str(exc),"details":{}}})

@app.get("/healthz", include_in_schema=False)
async def healthz(): return {"status":"ok"}

app.include_router(core_router, prefix="/api/v1")
app.include_router(domain_router, prefix="/api/v1")
app.include_router(sync_router, prefix="/api/v1")
app.include_router(ai_router, prefix="/api/v1")
app.include_router(agents_router, prefix="/api/v1")
app.include_router(automation_router, prefix="/api/v1")

async def init_db():
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
