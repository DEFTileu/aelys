"""Owner-authorized Gmail reads and explicit draft publication. No send operation."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from urllib.parse import quote, urlencode, urlparse
from uuid import NAMESPACE_URL, uuid5

import httpx
from app.ai.crypto import decrypt_secret, encrypt_secret
from app.core.config import get_settings
from app.core.db import get_db
from app.core.models import (
    AuthSession,
    Device,
    GmailCredential,
    GmailDraftLink,
    GmailOAuthState,
    MailAccount,
    MailDraft,
    MailMessage,
)
from app.core.security import current_principal, decode_token
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/mail/gmail", tags=["gmail"])
SCOPES = {"https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"}
COOKIE = "aelys_gmail_state"
API = "https://gmail.googleapis.com/gmail/v1/users/me"


def configured():
    settings = get_settings()
    parsed = urlparse(settings.gmail_redirect_uri or "")
    valid_uri = parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"})
    if not settings.gmail_client_id or not settings.gmail_client_secret or not valid_uri:
        raise HTTPException(503, detail={"code": "GMAIL_NOT_CONFIGURED", "message": "Set Gmail OAuth client ID, secret and callback URL on the Aelys backend."})
    return settings


async def google(method: str, url: str, **kwargs) -> dict:
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            response = await client.request(method, url, **kwargs)
        if response.status_code in {401, 403}:
            raise HTTPException(409, detail={"code": "GMAIL_RECONNECT_REQUIRED", "message": "Reconnect Gmail to renew access."})
        if not 200 <= response.status_code < 300:
            raise HTTPException(502, detail={"code": "GMAIL_UNAVAILABLE", "message": "Gmail did not confirm the request."})
        return response.json() if response.content else {}
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, detail={"code": "GMAIL_UNAVAILABLE", "message": "Gmail did not confirm the request."}) from None


async def account_for(db: AsyncSession, account_id: str, owner_id: str) -> MailAccount:
    account = await db.get(MailAccount, account_id)
    if not account or account.owner_id != owner_id or account.provider != "gmail" or account.deleted_at is not None:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Gmail account not found"})
    return account


async def access_token(db: AsyncSession, account: MailAccount) -> str:
    credential = await db.get(GmailCredential, account.id)
    if not credential:
        raise HTTPException(409, detail={"code": "GMAIL_RECONNECT_REQUIRED", "message": "Reconnect Gmail to renew access."})
    tokens = json.loads(decrypt_secret(credential.encrypted_tokens))
    if tokens.get("expires_at", 0) < time.time() + 60:
        settings = configured()
        refreshed = await google("POST", "https://oauth2.googleapis.com/token", data={"client_id": settings.gmail_client_id, "client_secret": settings.gmail_client_secret, "grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
        tokens.update(refreshed)
        tokens["expires_at"] = time.time() + int(refreshed.get("expires_in", 3600))
        credential.encrypted_tokens = encrypt_secret(json.dumps(tokens))
        await db.commit()
    return str(tokens["access_token"])


@router.get("/status")
async def status(principal=Depends(current_principal)):
    try:
        configured()
        return {"configured": True}
    except HTTPException:
        return {"configured": False}


@router.post("/connect")
async def connect(authorization: str = Header(), principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    settings = configured()
    user, _ = principal
    claims = decode_token(authorization.split(" ", 1)[1])
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
    db.add(GmailOAuthState(state_hash=hashlib.sha256(state.encode()).hexdigest(), owner_id=user.id, session_id=claims["sid"], encrypted_verifier=encrypt_secret(verifier), expires_at=datetime.now(UTC) + timedelta(minutes=10)))
    await db.commit()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({"client_id": settings.gmail_client_id, "redirect_uri": settings.gmail_redirect_uri, "response_type": "code", "scope": " ".join(sorted(SCOPES)), "state": state, "code_challenge": challenge, "code_challenge_method": "S256", "access_type": "offline", "prompt": "consent"})
    response = JSONResponse({"authorization_url": url})
    response.set_cookie(COOKIE, state, max_age=600, httponly=True, secure=settings.gmail_redirect_uri.startswith("https://"), samesite="lax", path="/api/v1/mail/gmail")
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/callback", include_in_schema=False)
async def callback(request: Request, state: str = Query(max_length=200), code: str | None = Query(default=None, max_length=4096), error: str | None = Query(default=None, max_length=100), db: AsyncSession=Depends(get_db)):
    settings = configured()
    if not secrets.compare_digest(request.cookies.get(COOKIE, ""), state):
        raise HTTPException(400, detail={"code": "INVALID_OAUTH_STATE", "message": "Restart Gmail connection in the same browser."})
    state_hash = hashlib.sha256(state.encode()).hexdigest()
    record = await db.get(GmailOAuthState, state_hash)
    if not record or record.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC):
        raise HTTPException(400, detail={"code": "INVALID_OAUTH_STATE", "message": "Gmail connection expired. Start again."})
    session = await db.get(AuthSession, record.session_id)
    device = await db.get(Device, session.device_id) if session and session.device_id else None
    if not session or session.revoked_at or session.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC) or (session.device_id and (not device or device.revoked_at)):
        raise HTTPException(401, detail={"code": "UNAUTHORIZED", "message": "Open an owner session and reconnect Gmail."})
    verifier, owner_id = decrypt_secret(record.encrypted_verifier), record.owner_id
    consumed = await db.execute(delete(GmailOAuthState).where(GmailOAuthState.state_hash == state_hash))
    await db.commit()
    if int(getattr(consumed, "rowcount", 0) or 0) != 1:
        raise HTTPException(400, detail={"code": "INVALID_OAUTH_STATE", "message": "Gmail connection already used."})
    if error or not code:
        return RedirectResponse("/mail?gmail=denied", status_code=303)
    tokens = await google("POST", "https://oauth2.googleapis.com/token", data={"client_id": settings.gmail_client_id, "client_secret": settings.gmail_client_secret, "redirect_uri": settings.gmail_redirect_uri, "code": code, "code_verifier": verifier, "grant_type": "authorization_code"})
    if not SCOPES.issubset(set(str(tokens.get("scope", "")).split())) or not tokens.get("refresh_token"):
        raise HTTPException(409, detail={"code": "GMAIL_SCOPE_REQUIRED", "message": "Reconnect Gmail and grant read and draft access."})
    profile = await google("GET", API + "/profile", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    email = str(profile["emailAddress"])
    account_id = str(uuid5(NAMESPACE_URL, f"aelys:gmail:{owner_id}:{email}"))
    account = await db.get(MailAccount, account_id)
    if not account:
        account = MailAccount(id=account_id, owner_id=owner_id, provider="gmail", external_id=email)
        db.add(account); await db.flush()
    account.deleted_at = None; account.connection_status = "connected"
    tokens["expires_at"] = time.time() + int(tokens.get("expires_in", 3600))
    credential = await db.get(GmailCredential, account_id)
    if credential: credential.encrypted_tokens = encrypt_secret(json.dumps(tokens))
    else: db.add(GmailCredential(account_id=account_id, encrypted_tokens=encrypt_secret(json.dumps(tokens))))
    await db.commit()
    response = RedirectResponse("/mail?gmail=connected", status_code=303)
    response.delete_cookie(COOKIE, path="/api/v1/mail/gmail")
    response.headers["Cache-Control"] = "no-store"
    return response


def plain_body(payload: dict) -> str:
    if payload.get("filename"): return ""
    if payload.get("mimeType") == "text/plain":
        data = payload.get("body", {}).get("data", "")
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", errors="replace")
    return "\n".join(text for part in payload.get("parts", []) if (text := plain_body(part)))


@router.post("/{account_id}/drafts/import")
async def import_drafts(account_id: str, page_token: str | None = Query(default=None, max_length=1000), principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    from email.utils import getaddresses
    user, _ = principal
    account = await account_for(db, account_id, user.id)
    headers = {"Authorization": f"Bearer {await access_token(db, account)}"}
    params = {"maxResults": "25"}
    if page_token: params["pageToken"] = page_token
    page = await google("GET", API + "/drafts", headers=headers, params=params)
    imported = 0
    for entry in page.get("drafts", []):
        remote_id = str(entry["id"])
        linked = (await db.execute(select(GmailDraftLink).where(GmailDraftLink.account_id == account_id, GmailDraftLink.remote_id == remote_id))).scalar_one_or_none()
        if linked: continue
        remote = await google("GET", API + "/drafts/" + quote(remote_id, safe=""), headers=headers, params={"format":"full"})
        message = remote.get("message", {})
        payload = message.get("payload", {})
        fields = {field["name"].lower(): field["value"] for field in payload.get("headers", [])}
        local_id = str(uuid5(NAMESPACE_URL, f"aelys:gmail-draft:{account_id}:{remote_id}"))
        draft = MailDraft(id=local_id, owner_id=user.id, account_id=account_id, thread_id=message.get("threadId"), recipients=[address for _, address in getaddresses([fields.get("to", "")])], subject=fields.get("subject", "")[:500], content=plain_body(payload))
        db.add(draft); await db.flush()
        db.add(GmailDraftLink(draft_id=local_id, account_id=account_id, remote_id=remote_id, state="ready"))
        imported += 1
    await db.commit()
    return {"imported": imported, "next_page_token": page.get("nextPageToken")}


@router.post("/{account_id}/sync")
async def sync_mail(account_id: str, page_token: str | None = Query(default=None, max_length=1000), principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user, _ = principal
    account = await account_for(db, account_id, user.id)
    headers = {"Authorization": f"Bearer {await access_token(db, account)}"}
    params = {"maxResults": "25", "q": "-in:drafts"}
    if page_token: params["pageToken"] = page_token
    page = await google("GET", API + "/messages", headers=headers, params=params)
    imported = 0
    for entry in page.get("messages", []):
        remote_id = str(entry["id"])
        local_id = str(uuid5(NAMESPACE_URL, f"aelys:gmail-message:{account_id}:{remote_id}"))
        if await db.get(MailMessage, local_id): continue
        message = await google("GET", API + "/messages/" + quote(remote_id, safe=""), headers=headers, params={"format": "full"})
        payload = message.get("payload", {})
        fields = {field["name"].lower(): field["value"] for field in payload.get("headers", [])}
        db.add(MailMessage(id=local_id, owner_id=user.id, account_id=account_id, thread_id=str(message.get("threadId", "")), sender=fields.get("from", "")[:320], recipients=[fields.get("to", "")], subject=fields.get("subject", "(No subject)")[:500], body=plain_body(payload) or str(message.get("snippet", "")), received_at=datetime.fromtimestamp(int(message.get("internalDate", 0)) / 1000, UTC), sync_origin="gmail"))
        imported += 1
    await db.commit()
    return {"imported": imported, "next_page_token": page.get("nextPageToken")}


class PublishDraft(BaseModel):
    version: int = Field(ge=1)


@router.post("/{account_id}/drafts/{draft_id}")
async def publish_draft(account_id: str, draft_id: str, body: PublishDraft, principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user, _ = principal
    account = await account_for(db, account_id, user.id)
    draft = await db.get(MailDraft, draft_id)
    if not draft or draft.owner_id != user.id or draft.deleted_at is not None:
        raise HTTPException(404, detail={"code":"NOT_FOUND","message":"Draft not found"})
    if draft.version != body.version:
        raise HTTPException(409, detail={"code":"VERSION_CONFLICT","message":"Reload the draft before saving to Gmail."})
    token = await access_token(db, account)
    link = await db.get(GmailDraftLink, draft_id)
    if link and (link.account_id != account_id or link.state != "ready"):
        raise HTTPException(409, detail={"code":"GMAIL_DRAFT_UNCONFIRMED","message":"Check this draft in Gmail before trying again; its previous save was not confirmed."})
    # Build MIME before claiming the publication, so invalid headers do not leave a pending record.
    mime = EmailMessage()
    try:
        mime["To"] = ", ".join(draft.recipients); mime["Subject"] = draft.subject
        mime["From"] = account.external_id
        mime.set_content(draft.content)
    except ValueError:
        raise HTTPException(422, detail={"code":"VALIDATION_ERROR","message":"Draft address and subject must not contain newlines."}) from None
    payload = {"message": {"raw": base64.urlsafe_b64encode(mime.as_bytes()).decode()}}
    if link:
        claimed = await db.execute(update(GmailDraftLink).where(GmailDraftLink.draft_id == draft_id, GmailDraftLink.state == "ready").values(state="saving"))
        if int(getattr(claimed, "rowcount", 0) or 0) != 1:
            raise HTTPException(409, detail={"code":"GMAIL_DRAFT_BUSY","message":"This draft is already being saved."})
    else:
        link = GmailDraftLink(draft_id=draft_id, account_id=account_id, state="saving")
        db.add(link)
    await db.commit()
    remote_id = link.remote_id
    result = await google("PUT" if remote_id else "POST", API + "/drafts" + ("/" + quote(remote_id, safe="") if remote_id else ""), headers={"Authorization": f"Bearer {token}"}, json=payload)
    link.remote_id = str(result["id"]); link.state = "ready"
    await db.commit()
    return {"saved": True, "draft_id": draft_id}


@router.post("/{account_id}/disconnect")
async def disconnect(account_id: str, principal=Depends(current_principal), db: AsyncSession=Depends(get_db)):
    user, _ = principal
    account = await account_for(db, account_id, user.id)
    # Remove local access first. A provider revocation outage must not retain credentials.
    credential = await db.get(GmailCredential, account_id)
    revoke_token = None
    if credential:
        tokens = json.loads(decrypt_secret(credential.encrypted_tokens))
        revoke_token = tokens.get("refresh_token")
        await db.delete(credential)
    account.connection_status = "disconnected"
    await db.commit()
    revoked = False
    if revoke_token:
        try:
            await google("POST", "https://oauth2.googleapis.com/revoke", data={"token": revoke_token})
            revoked = True
        except HTTPException:
            pass
    return {"disconnected": True, "provider_revoked": revoked}
