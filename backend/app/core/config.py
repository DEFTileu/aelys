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
    # Creating an owner with a password is off by default: a fresh server is claimed with the console setup token.
    # Set true only for legacy clients that still create the first owner with email and password.
    password_bootstrap_enabled: bool = False
    # Existing owners keep password sign-in until a key-bound device is registered and the owner switches it off.
    password_login_enabled: bool = True
    rate_limit_enabled: bool = True
    # Number of reverse proxies in front of the server; 0 trusts only the socket peer (X-Forwarded-For is ignored).
    trusted_proxy_count: int = 0
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
