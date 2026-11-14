from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware

from .agents.api import router as agents_router
from .ai.api import router as ai_router
from .ai.memory_api import router as memory_router
from .automation.api import router as automation_router
from .automation.hooks import automation_loop, wait_for_automations
from .companion.api import router as companion_router
from .companion.channel import router as companion_channel_router
from .companion.hub import hub, install_change_listeners
from .core import models  # noqa: F401 - register domain metadata
from .core.api import router as core_router
from .core.browser_auth import router as browser_auth_router
from .core.db import Base, engine
from .core.device_auth import announce_first_run_token
from .core.device_auth import router as device_auth_router
from .core.native_auth import router as native_auth_router
from .domains.api import router as domain_router
from .domains.gmail import router as gmail_router
from .domains.google_calendar_api import router as calendar_router
from .domains.google_calendar_oauth import router as calendar_oauth_router
from .domains.paged_reads import router as paged_reads_router
from .sync.api import router as sync_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .integrations.telegram_service import connector_loop
    with suppress(Exception):  # a missing schema must not stop startup; the console token is a convenience
        await announce_first_run_token()
    from .english.reminders import reminder_loop
    install_change_listeners()
    worker = asyncio.create_task(connector_loop(), name="telegram-business")
    reminders = asyncio.create_task(reminder_loop(), name="english-reminders")
    from .companion.weather import refresh_loop
    weather = asyncio.create_task(refresh_loop(), name="companion-weather")
    automations = asyncio.create_task(automation_loop(), name="automation-outbox")
    try:
        yield
    finally:
        await hub.wait_idle(timeout=5)  # board pushes in flight must not outlive the loop
        await wait_for_automations()
        for task in (worker, reminders, weather, automations):
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

app = FastAPI(title="Aelys API", version="0.1.0", openapi_url="/api/v1/openapi.json", lifespan=lifespan)
# Lists (mail, notes, tasks) shrink several-fold; Starlette never buffers text/event-stream, so AI streaming is untouched.
app.add_middleware(GZipMiddleware, minimum_size=1024)

class OAuthAccessLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and len(record.args) >= 3:
            args = list(record.args)
            if isinstance(args[2], str):
                for path in ("/api/v1/mail/gmail/callback", "/api/v1/mail/gmail/authorize", "/api/v1/calendar/google/callback", "/api/v1/calendar/google/authorize"):
                    if args[2].startswith(path):
                        args[2] = path
                        break
                record.args = tuple(args)
        return True

logging.getLogger("uvicorn.access").addFilter(OAuthAccessLogFilter())

@app.middleware("http")
async def request_id(request: Request, call_next):
    request_id = str(uuid.uuid4())
    started = time.perf_counter()
    response = await call_next(request)
    # Server time only (headers ready), so client timing shows how much is network.
    response.headers["Server-Timing"] = f"app;dur={(time.perf_counter() - started) * 1000:.1f}"
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
    if request.url.path in {"/api/v1/mail/gmail/authorize", "/api/v1/mail/gmail/callback"}:
        return JSONResponse(status_code=422, content={"detail": {"code": "INVALID_OAUTH_STATE", "message": "Restart the Gmail connection in Aelys."}})
    if request.url.path in {"/api/v1/calendar/google/authorize", "/api/v1/calendar/google/callback"}:
        return JSONResponse(status_code=422, content={"detail": {"code": "INVALID_OAUTH_STATE", "message": "Restart the Calendar connection in Aelys."}})
    if request.url.path.startswith("/api/v1/auth/native/"):
        return JSONResponse(status_code=422, content={"detail": {"code": "VALIDATION_ERROR", "message": "Invalid native authentication request"}})
    if request.url.path.startswith("/api/v1/companion/devices/"):  # the default body echoes the input, e.g. the Wi-Fi blob
        return JSONResponse(status_code=422, content={"detail": {"code": "VALIDATION_ERROR", "message": "Invalid request"}})
    if request.url.path == "/api/v1/integrations/telegram/connect":
        return JSONResponse(status_code=422, content={"detail": {"code": "VALIDATION_ERROR", "message": "Некорректный токен Telegram."}})
    return await request_validation_exception_handler(request, exc)

@app.exception_handler(ValueError)
async def value_error(_: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"error":{"code":"VALIDATION_ERROR","message":str(exc),"details":{}}})

@app.get("/healthz", include_in_schema=False)
async def healthz(): return {"status":"ok"}

app.include_router(companion_channel_router, prefix="/api/v1")  # before core: no /devices/{device_id} pattern may shadow /devices/channel
app.include_router(core_router, prefix="/api/v1")
app.include_router(device_auth_router, prefix="/api/v1")
app.include_router(companion_router, prefix="/api/v1")
app.include_router(browser_auth_router, prefix="/api/v1")
app.include_router(native_auth_router, prefix="/api/v1")
app.include_router(domain_router, prefix="/api/v1")
app.include_router(paged_reads_router, prefix="/api/v1")
app.include_router(sync_router, prefix="/api/v1")
app.include_router(ai_router, prefix="/api/v1")
app.include_router(memory_router, prefix="/api/v1")
app.include_router(agents_router, prefix="/api/v1")
app.include_router(automation_router, prefix="/api/v1")
app.include_router(gmail_router, prefix="/api/v1")
app.include_router(calendar_oauth_router, prefix="/api/v1")
app.include_router(calendar_router, prefix="/api/v1")
from .integrations.telegram_api import router as telegram_router

app.include_router(telegram_router, prefix="/api/v1")

async def init_db():
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)

from .ai.knowledge import router as knowledge_router

app.include_router(knowledge_router, prefix="/api/v1")

from .english.api import router as english_router
from .english.lessons import router as english_course_router

app.include_router(english_router, prefix="/api/v1")
app.include_router(english_course_router, prefix="/api/v1")
