from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .agents.api import router as agents_router
from .ai.api import router as ai_router
from .automation.api import router as automation_router
from .core import models  # noqa: F401 - register domain metadata
from .core.api import router as core_router
from .core.browser_auth import router as browser_auth_router
from .core.db import Base, engine
from .core.device_auth import announce_first_run_token
from .core.device_auth import router as device_auth_router
from .core.native_auth import router as native_auth_router
from .domains.api import router as domain_router
from .domains.gmail import router as gmail_router
from .sync.api import router as sync_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .integrations.telegram_service import connector_loop
    with suppress(Exception):  # a missing schema must not stop startup; the console token is a convenience
        await announce_first_run_token()
    worker = asyncio.create_task(connector_loop(), name="telegram-business")
    try:
        yield
    finally:
        worker.cancel()
        with suppress(asyncio.CancelledError):
            await worker

app = FastAPI(title="Aelys API", version="0.1.0", openapi_url="/api/v1/openapi.json", lifespan=lifespan)

class OAuthAccessLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and len(record.args) >= 3:
            args = list(record.args)
            if isinstance(args[2], str) and args[2].startswith("/api/v1/mail/gmail/callback"):
                args[2] = "/api/v1/mail/gmail/callback"
                record.args = tuple(args)
        return True

logging.getLogger("uvicorn.access").addFilter(OAuthAccessLogFilter())

@app.middleware("http")
async def request_id(request: Request, call_next):
    request_id = str(uuid.uuid4())
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(self)"
    if (request.url.path.startswith("/api/v1/auth/") or request.url.path.startswith("/api/v1/integrations/telegram/")):
        response.headers["Cache-Control"] = "no-store"
    return response

@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    if request.url.path.startswith("/api/v1/auth/native/"):
        return JSONResponse(status_code=422, content={"detail": {"code": "VALIDATION_ERROR", "message": "Invalid native authentication request"}})
    if request.url.path == "/api/v1/integrations/telegram/connect":
        return JSONResponse(status_code=422, content={"detail": {"code": "VALIDATION_ERROR", "message": "Некорректный токен Telegram."}})
    return await request_validation_exception_handler(request, exc)

@app.exception_handler(ValueError)
async def value_error(_: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"error":{"code":"VALIDATION_ERROR","message":str(exc),"details":{}}})

@app.get("/healthz", include_in_schema=False)
async def healthz(): return {"status":"ok"}

app.include_router(core_router, prefix="/api/v1")
app.include_router(device_auth_router, prefix="/api/v1")
app.include_router(browser_auth_router, prefix="/api/v1")
app.include_router(native_auth_router, prefix="/api/v1")
app.include_router(domain_router, prefix="/api/v1")
app.include_router(sync_router, prefix="/api/v1")
app.include_router(ai_router, prefix="/api/v1")
app.include_router(agents_router, prefix="/api/v1")
app.include_router(automation_router, prefix="/api/v1")
app.include_router(gmail_router, prefix="/api/v1")
from .integrations.telegram_api import router as telegram_router

app.include_router(telegram_router, prefix="/api/v1")

async def init_db():
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
