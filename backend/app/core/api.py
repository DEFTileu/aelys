from __future__ import annotations
import secrets
from datetime import timezone
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from .config import get_settings
from .db import get_db
from .models import AuditLog, AuthSession, Device, Project, ProjectGrant, User, now
from .schemas import DeviceEnroll, DeviceResponse, LoginRequest, ProjectCreate, ProjectResponse, TokenResponse
from .security import current_principal, create_token, decode_refresh_token, hash_password, token_hash, verify_password, decode_token

router = APIRouter()

@router.post("/auth/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if not user or not user.password_hash or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, detail={"code":"UNAUTHORIZED","message":"Invalid credentials"})
    session_id = secrets.token_urlsafe(24)
    access = create_token(user.id, "access", get_settings().access_token_minutes * 60, session_id=session_id)
    refresh = create_token(user.id, "refresh", get_settings().refresh_token_days * 86400, session_id=session_id)
    db.add(AuthSession(id=session_id, owner_id=user.id, refresh_token_hash=token_hash(refresh), expires_at=now()+__import__("datetime").timedelta(days=get_settings().refresh_token_days)))
    await db.commit()
    return TokenResponse(access_token=access, refresh_token=refresh)

@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(body: dict, db: AsyncSession = Depends(get_db)):
    claims = decode_refresh_token(body.get("refresh_token", "")); user = await db.get(User, claims["sub"])
    if not user: raise HTTPException(401, detail={"code":"UNAUTHORIZED","message":"Unknown owner"})
    raw_refresh=body.get("refresh_token",""); session_query=select(AuthSession).where(AuthSession.owner_id==user.id,AuthSession.refresh_token_hash==token_hash(raw_refresh),AuthSession.revoked_at.is_(None))
    if claims.get("sid"): session_query=session_query.where(AuthSession.id==claims["sid"])
    session=(await db.execute(session_query)).scalar_one_or_none()
    if not session:
        raise HTTPException(401,detail={"code":"UNAUTHORIZED","message":"Refresh session revoked or expired"})
    expires=session.expires_at.replace(tzinfo=timezone.utc) if session.expires_at.tzinfo is None else session.expires_at
    if expires <= now(): raise HTTPException(401,detail={"code":"UNAUTHORIZED","message":"Refresh session revoked or expired"})
    device_id = claims.get("device_id")
    if device_id:
        device = await db.get(Device, device_id)
        if not device or device.revoked_at or device.owner_id != user.id: raise HTTPException(401, detail={"code":"DEVICE_REVOKED","message":"Device credential revoked"})
    session.revoked_at=now(); new_session_id=secrets.token_urlsafe(24); new_refresh=create_token(user.id,"refresh",get_settings().refresh_token_days*86400,device_id,new_session_id); db.add(AuthSession(id=new_session_id,owner_id=user.id,device_id=device_id,refresh_token_hash=token_hash(new_refresh),expires_at=now()+__import__("datetime").timedelta(days=get_settings().refresh_token_days))); await db.commit()
    return TokenResponse(access_token=create_token(user.id,"access",get_settings().access_token_minutes*60,device_id,new_session_id), refresh_token=new_refresh)

@router.post("/auth/logout")
async def logout(authorization: str | None = Header(default=None), principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    token = authorization.split(" ", 1)[1] if authorization and authorization.lower().startswith("bearer ") else ""
    claims = decode_token(token)
    user, _ = principal
    if claims.get("sid"):
        session = await db.get(AuthSession, claims["sid"])
        if session and session.owner_id == user.id:
            session.revoked_at = now()
    else:
        for session in (await db.execute(select(AuthSession).where(AuthSession.owner_id == user.id, AuthSession.revoked_at.is_(None)))).scalars():
            session.revoked_at = now()
    await db.commit()
    return {"logged_out": True}

@router.post("/auth/bootstrap", response_model=TokenResponse, include_in_schema=False)
async def bootstrap(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    """First-owner setup endpoint; disable or protect it after initial enrollment."""
    if (await db.execute(select(User))).first(): raise HTTPException(409, detail={"code":"ALREADY_INITIALIZED","message":"Owner already exists"})
    user = User(email=body.email, password_hash=hash_password(body.password)); db.add(user); await db.commit()
    session_id=secrets.token_urlsafe(24); refresh=create_token(user.id,"refresh",30*86400,session_id=session_id); db.add(AuthSession(id=session_id,owner_id=user.id,refresh_token_hash=token_hash(refresh),expires_at=now()+__import__("datetime").timedelta(days=30))); await db.commit()
    return TokenResponse(access_token=create_token(user.id,"access",900,session_id=session_id), refresh_token=refresh)

@router.get("/me")
async def me(principal=Depends(current_principal)):
    user, device = principal
    return {"id": user.id, "email": user.email, "device_id": device.id if device else None}

@router.get("/devices", response_model=list[DeviceResponse])
async def devices(principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    return list((await db.execute(select(Device).where(Device.owner_id == user.id))).scalars())

@router.post("/devices/enroll")
async def enroll(body: DeviceEnroll, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal; raw = secrets.token_urlsafe(32)
    device = Device(owner_id=user.id, platform=body.platform, display_name=body.display_name, public_key=body.public_key, credential_hash=hash_password(raw))
    db.add(device); session_id=secrets.token_urlsafe(24); db.add(AuthSession(id=session_id,owner_id=user.id,device_id=device.id,refresh_token_hash=token_hash(secrets.token_urlsafe(32)),expires_at=now()+__import__("datetime").timedelta(minutes=get_settings().access_token_minutes))); await db.commit()
    return {"device_id": device.id, "credential": raw, "access_token": create_token(user.id,"access",900,device.id,session_id)}

@router.post("/devices/{device_id}/revoke")
async def revoke(device_id: str, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal; device = await db.get(Device, device_id)
    if not device or device.owner_id != user.id: raise HTTPException(404, detail={"code":"NOT_FOUND","message":"Device not found"})
    from .models import now
    device.revoked_at = now(); device.credential_version += 1
    db.add(AuditLog(owner_id=user.id,action="device.revoke",actor="owner",scope=f"device:{device_id}",decision="allow",outcome="revoked",correlation_id=device_id,redacted_metadata={}))
    await db.commit(); return {"revoked": True}

@router.get("/projects", response_model=list[ProjectResponse])
async def list_projects(principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal; return list((await db.execute(select(Project).where(Project.owner_id == user.id, Project.deleted_at.is_(None)))).scalars())

@router.post("/projects", response_model=ProjectResponse)
async def create_project(body: ProjectCreate, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal; project = Project(owner_id=user.id, name=body.name, description=body.description); db.add(project); await db.commit(); await db.refresh(project); return project

@router.post("/projects/{project_id}/grants")
async def create_project_grant(project_id: str, body: dict, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user,_=principal; project=await db.get(Project,project_id)
    if not project or project.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Project not found"})
    device=await db.get(Device,body.get("device_id"))
    if not device or device.owner_id!=user.id or device.revoked_at: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Device not found"})
    network_allowed=bool(body.get("network_allowed",False))
    grant=ProjectGrant(owner_id=user.id,project_id=project_id,device_id=device.id,policy_id=str(body.get("policy_id") or __import__("uuid").uuid4()),isolation_validated=False,isolation_nonce=__import__("secrets").token_urlsafe(32),network_allowed=network_allowed)
    db.add(grant); db.add(AuditLog(owner_id=user.id,action="project.grant.create",actor="owner",scope=f"project:{project_id}/device:{device.id}",decision="allow",outcome="created",correlation_id=grant.id or project_id,redacted_metadata={"isolation_validated":False,"network_allowed":network_allowed})); await db.commit(); await db.refresh(grant)
    return {"id":grant.id,"project_id":grant.project_id,"device_id":grant.device_id,"policy_id":grant.policy_id,"isolation_nonce":grant.isolation_nonce,"isolation_validated":False,"network_allowed":grant.network_allowed}

@router.post("/projects/{project_id}/grants/{grant_id}/revoke")
async def revoke_project_grant(project_id:str,grant_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; grant=await db.get(ProjectGrant,grant_id)
    if not grant or grant.owner_id!=user.id or grant.project_id!=project_id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Grant not found"})
    grant.revoked_at=now(); db.add(AuditLog(owner_id=user.id,action="project.grant.revoke",actor="owner",scope=f"grant:{grant_id}",decision="allow",outcome="revoked",correlation_id=grant_id,redacted_metadata={})); await db.commit(); return {"revoked":True}
