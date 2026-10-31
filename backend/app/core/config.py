from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite+aiosqlite:///./aelys.db"
    secret_key: str = Field(min_length=32)
    provider_encryption_key: str | None = Field(default=None, min_length=32)
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    setup_token_minutes: int = 30
    device_challenge_seconds: int = 60
    pairing_ttl_seconds: int = 120
    pairing_max_attempts: int = 5
    # Password bootstrap stays available for existing installs; set false on public hosts so only a setup token can claim ownership.
    password_bootstrap_enabled: bool = True
    browser_origins: list[str] = ["http://127.0.0.1:5173", "http://localhost:5173"]
    gmail_client_id: str | None = None
    gmail_client_secret: str | None = Field(default=None, repr=False)
    gmail_redirect_uri: str | None = None
    runtime_signing_key: str | None = None
    runtime_trust_public_key: str | None = None
    runtime_trust_manifest: str | None = None
    model_config = SettingsConfigDict(env_prefix="AELYS_", env_file=".env", extra="ignore")

@lru_cache
def get_settings() -> Settings:
    return Settings.model_validate({})
