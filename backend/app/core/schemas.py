from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field

class ErrorBody(BaseModel):
    code: str; message: str; details: dict = Field(default_factory=dict)
class ErrorEnvelope(BaseModel):
    error: ErrorBody; request_id: str
class LoginRequest(BaseModel):
    email: str; password: str = Field(min_length=8)
class TokenResponse(BaseModel):
    access_token: str; refresh_token: str; token_type: str = "bearer"
class DeviceEnroll(BaseModel):
    platform: str = Field(pattern="^(web|macos|android|helper)$")
    display_name: str = Field(min_length=1, max_length=200)
    public_key: str | None = Field(default=None, max_length=200)
class DeviceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str; platform: str; display_name: str; revoked_at: datetime | None
class ProjectCreate(BaseModel): name: str = Field(min_length=1, max_length=200); description: str = ""
class ProjectResponse(ProjectCreate):
    model_config = ConfigDict(from_attributes=True)
    id: str; status: str; version: int
