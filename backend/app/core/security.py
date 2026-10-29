from __future__ import annotations
import base64, hashlib, hmac, json, secrets, time
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession
from .config import get_settings
from .db import get_db
from .models import AuthSession, Device, User

bearer_scheme = HTTPBearer(auto_error=False)

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 240_000)
    return f"pbkdf2_sha256$240000${salt.hex()}${digest.hex()}"

def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, rounds, salt_hex, digest_hex = encoded.split("$")
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds))
        return scheme == "pbkdf2_sha256" and hmac.compare_digest(candidate.hex(), digest_hex)
    except (ValueError, TypeError):
        return False

def _b64(value: bytes) -> str: return base64.urlsafe_b64encode(value).rstrip(b"=").decode()
def _unb64(value: str) -> bytes: return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

def create_token(subject: str, kind: str, expires_seconds: int, device_id: str | None = None, session_id: str | None = None) -> str:
    header = _b64(json.dumps({"alg":"HS256","typ":"JWT"}, separators=(",",":")).encode())
    payload = {"sub": subject, "typ": kind, "exp": int(time.time()) + expires_seconds, "jti": secrets.token_urlsafe(18)}
    if device_id: payload["device_id"] = device_id
    if session_id: payload["sid"] = session_id
    body = _b64(json.dumps(payload, separators=(",",":")).encode())
    signing = f"{header}.{body}".encode()
    sig = hmac.new(get_settings().secret_key.encode(), signing, hashlib.sha256).digest()
    return f"{header}.{body}.{_b64(sig)}"

def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()

def decode_token(token: str) -> dict:
    try:
        header, body, signature = token.split(".")
        signing = f"{header}.{body}".encode()
        expected = hmac.new(get_settings().secret_key.encode(), signing, hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(signature)): raise ValueError
        payload = json.loads(_unb64(body))
        if int(payload["exp"]) < int(time.time()): raise ValueError
        return payload
    except (ValueError, KeyError, json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code":"UNAUTHORIZED","message":"Invalid or expired token"})

def decode_refresh_token(token: str) -> dict:
    claims = decode_token(token)
    if claims.get("typ") != "refresh":
        raise HTTPException(status_code=401, detail={"code":"UNAUTHORIZED","message":"Refresh token required"})
    return claims

async def current_principal(credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme), db: AsyncSession = Depends(get_db)) -> tuple[User, Device | None]:
    if not credentials:
        raise HTTPException(status_code=401, detail={"code":"UNAUTHORIZED","message":"Bearer token required"})
    claims = decode_token(credentials.credentials)
    if claims.get("typ") != "access":
        raise HTTPException(status_code=401, detail={"code":"UNAUTHORIZED","message":"Access token required"})
    user = await db.get(User, claims["sub"])
    if not user: raise HTTPException(status_code=401, detail={"code":"UNAUTHORIZED","message":"Unknown owner"})
    session_id = claims.get("sid")
    if not session_id:
        raise HTTPException(status_code=401, detail={"code":"UNAUTHORIZED","message":"Session-bound access token required"})
    session = await db.get(AuthSession, session_id)
    if not session or session.owner_id != user.id or session.revoked_at:
        raise HTTPException(status_code=401, detail={"code":"UNAUTHORIZED","message":"Session revoked"})
    device = None
    if claims.get("device_id"):
        device = await db.get(Device, claims["device_id"])
        if not device or device.owner_id != user.id or device.revoked_at:
            raise HTTPException(status_code=401, detail={"code":"DEVICE_REVOKED","message":"Device credential revoked"})
    return user, device
