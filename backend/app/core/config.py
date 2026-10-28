from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    database_url: str = "sqlite+aiosqlite:///./aelys.db"
    secret_key: str = Field(min_length=32)
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    runtime_signing_key: str | None = None
    runtime_trust_public_key: str | None = None
    runtime_trust_manifest: str | None = None
    model_config = SettingsConfigDict(env_prefix="AELYS_", env_file=".env", extra="ignore")

@lru_cache
def get_settings() -> Settings:
    return Settings.model_validate({})
