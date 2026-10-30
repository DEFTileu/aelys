"""Authenticated configuration API; tokens are write-only and never serialized."""
import hmac
import re
import secrets
from datetime import datetime, timedelta

from app.ai.crypto import decrypt_secret, encrypt_secret
from app.core.db import get_db
from app.core.models import AIProvider, AIProviderSecret, now
from app.core.security import current_principal, token_hash
from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import telegram_service as service
from .telegram_models import TelegramBusinessMessage, TelegramIntegration
from .telegram_transport import TelegramClient, TelegramError

router = APIRouter(prefix="/integrations/telegram", tags=["Telegram Business"])


class ConnectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bot_token: SecretStr = Field(min_length=20, max_length=200)


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    enabled: bool | None = None
    auto_reply: bool | None = None
    provider_id: str | None = Field(default=None, max_length=36)
    model: str | None = Field(default=None, max_length=200)
    instructions: str | None = Field(default=None, max_length=10_000)


class MessageVersion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)


class SendIn(MessageVersion):
    text: str = Field(min_length=1, max_length=4096)


class ConnectionOut(BaseModel):
    id: str
    enabled: bool
    can_reply: bool
    telegram_user_id: int


class StatusOut(BaseModel):
    configured: bool
    id: str | None
    version: int | None
    bot_username: str | None
    bot_name: str | None
    business_capable: bool
    enabled: bool
    auto_reply: bool
    owner_telegram_id: int | None
    provider_id: str | None
    model: str | None
    instructions: str
    last_polled_at: datetime | None
    last_error_code: str | None
    connections: list[ConnectionOut]


class BindingOut(BaseModel):
    url: str
    expires_at: datetime


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    version: int
    business_connection_id: str
    chat_id: int
    telegram_message_id: int
    sender_id: int | None
    chat_title: str
    text: str
    sent_at: datetime
    direction: str
    draft_text: str | None
    draft_status: str
    draft_error_code: str | None
    deleted_at: datetime | None


@router.get("/status", response_model=StatusOut)
async def status(response: Response, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    return await service.status(db, principal[0].id)


@router.post("/connect", response_model=StatusOut)
async def connect(body: ConnectIn, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    token = body.bot_token.get_secret_value().strip()
    if not re.fullmatch(r"[0-9]{5,20}:[A-Za-z0-9_-]{20,150}", token):
        raise service.error(422, "TELEGRAM_TOKEN_INVALID", "Введите токен бота из BotFather.")
    try:
        async with TelegramClient(token) as client:
            bot = await client.get_me()
            hook = await client.get_webhook_info()
    except TelegramError as exc:
        raise service.error(503, service.remote_code(exc), "Не удалось проверить токен Telegram.") from None
    if hook.get("url"):
        raise service.error(409, "TELEGRAM_WEBHOOK_CONFLICT", "У бота уже настроен webhook. Отключите его самостоятельно, если хотите использовать локальный опрос Aelys.")
    if not service.integer(bot.get("id")) or bot.get("is_bot") is not True or not isinstance(bot.get("username"), str) or not re.fullmatch(r"[A-Za-z0-9_]{3,64}", bot["username"]):
        raise service.error(503, "TELEGRAM_RESPONSE_INVALID", "Telegram вернул некорректные данные бота.")
    item = (await db.execute(select(TelegramIntegration).where(TelegramIntegration.owner_id == principal[0].id))).scalar_one_or_none()
    if item and item.encrypted_token and item.bot_id == bot["id"] and hmac.compare_digest(decrypt_secret(item.encrypted_token), token):
        # Retrying a successful credential submission must not purge a live
        # connector's binding/messages or disable its configured assistant.
        item.business_capable = bot.get("can_connect_to_business") is True
        item.bot_username = bot["username"]
        await db.commit()
        return await service.status(db, principal[0].id)
    if item is None:
        item = TelegramIntegration(owner_id=principal[0].id, bot_id=bot["id"], bot_username=bot["username"], bot_name=str(bot.get("first_name") or "Telegram")[:200], business_capable=bot.get("can_connect_to_business") is True)
        db.add(item)
    else:
        # Replacing a bot invalidates every binding, cached permission and update.
        await service.purge_integration(db, item)
        item.bot_id = bot["id"]; item.bot_username = bot["username"]; item.bot_name = str(bot.get("first_name") or "Telegram")[:200]
        item.business_capable = bot.get("can_connect_to_business") is True
        item.version += 1
    item.encrypted_token = encrypt_secret(token)
    item.enabled = True; item.auto_reply = False; item.owner_telegram_id = None
    item.binding_code_hash = None; item.binding_expires_at = None; item.last_update_id = -1
    item.lease_owner = None; item.lease_expires_at = None; item.last_error_code = None
    await db.commit()
    return await service.status(db, principal[0].id)


@router.post("/binding", response_model=BindingOut)
async def binding(principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    item = await service.get_integration(db, principal[0].id)
    if not item.enabled:
        raise service.error(409, "TELEGRAM_PAUSED", "Возобновите подключение перед привязкой.")
    code = secrets.token_urlsafe(24)
    item.binding_code_hash = token_hash(code); item.binding_expires_at = now() + timedelta(minutes=10)
    item.version += 1
    await db.commit()
    return {"url": f"https://t.me/{item.bot_username}?start=aelys_{code}", "expires_at": item.binding_expires_at}


@router.patch("/settings", response_model=StatusOut)
async def settings(body: SettingsIn, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    item = await service.get_integration(db, principal[0].id)
    values = body.model_dump(exclude_unset=True, exclude={"version"})
    # Null is supported only for nullable provider/model fields.
    if any(values.get(key) is None for key in ("enabled", "auto_reply", "instructions") if key in values):
        raise service.error(422, "VALIDATION_ERROR", "Настройка не может быть пустой.")
    provider_id = values.get("provider_id", item.provider_id)
    assistant_enabled = values.get("auto_reply", item.auto_reply) and values.get("enabled", item.enabled)
    if provider_id and ("provider_id" in values or assistant_enabled):
        provider = await db.get(AIProvider, provider_id)
        secret = (await db.execute(select(AIProviderSecret).where(AIProviderSecret.provider_id == provider_id, AIProviderSecret.owner_id == item.owner_id))).scalar_one_or_none()
        if not provider or provider.owner_id != item.owner_id or provider.deleted_at or not provider.enabled or not secret:
            raise service.error(409, "PROVIDER_REQUIRED", "Настройте активного AI-провайдера с ключом.")
    if assistant_enabled:
        if not provider_id:
            raise service.error(409, "PROVIDER_REQUIRED", "Для автоответов выберите настроенного AI-провайдера.")
        if not item.owner_telegram_id or not item.business_capable:
            raise service.error(409, "TELEGRAM_BINDING_REQUIRED", "Привяжите владельца и включите Secretary Mode в BotFather.")
        if not str(values.get("instructions", item.instructions)).strip():
            raise service.error(409, "TELEGRAM_INSTRUCTIONS_REQUIRED", "Опишите бизнес и правила ответов ассистента.")
    claimed = await db.execute(update(TelegramIntegration).where(TelegramIntegration.id == item.id, TelegramIntegration.version == body.version).values(**values, version=TelegramIntegration.version + 1))
    await db.commit()
    if int(getattr(claimed, "rowcount", 0) or 0) != 1:
        raise service.error(409, "VERSION_CONFLICT", "Настройки уже изменились. Обновите подключение.")
    return await service.status(db, principal[0].id)


@router.post("/disconnect")
async def disconnect(principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    item = await service.get_integration(db, principal[0].id, configured=False)
    item.enabled = False; item.auto_reply = False; item.encrypted_token = None
    item.owner_telegram_id = None; item.binding_code_hash = None; item.binding_expires_at = None
    item.lease_owner = None; item.lease_expires_at = None; item.version += 1
    await service.purge_integration(db, item)
    await db.commit()
    return {"disconnected": True}


@router.post("/sync")
async def sync(principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    item = await service.get_integration(db, principal[0].id)
    if not item.enabled:
        raise service.error(409, "TELEGRAM_PAUSED", "Подключение приостановлено.")
    integration_id = item.id
    await db.commit()
    processed = await service.poll_once(integration_id, timeout=0)
    return {"processed": processed}


@router.get("/messages", response_model=list[MessageOut])
async def messages(response: Response, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    return list((await db.execute(select(TelegramBusinessMessage).where(TelegramBusinessMessage.owner_id == principal[0].id, TelegramBusinessMessage.deleted_at.is_(None)).order_by(TelegramBusinessMessage.sent_at.desc()).limit(100))).scalars())


async def owned_message(db: AsyncSession, owner_id: str, message_id: str) -> tuple[TelegramIntegration, TelegramBusinessMessage]:
    item = await service.get_integration(db, owner_id)
    message = await db.get(TelegramBusinessMessage, message_id)
    if not message or message.owner_id != owner_id or message.integration_id != item.id or message.deleted_at:
        raise service.error(404, "NOT_FOUND", "Сообщение не найдено.")
    return item, message


@router.post("/messages/{message_id}/draft", response_model=MessageOut)
async def draft(message_id: str, body: MessageVersion, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    item, message = await owned_message(db, principal[0].id, message_id)
    return await service.generate_draft(db, item, message, body.version)


@router.post("/messages/{message_id}/send", response_model=MessageOut)
async def send(message_id: str, body: SendIn, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    item, message = await owned_message(db, principal[0].id, message_id)
    try:
        return await service.send_reply(db, item, message, body.version, body.text)
    except TelegramError as exc:
        raise service.error(503, service.remote_code(exc), "Telegram недоступен.") from None
