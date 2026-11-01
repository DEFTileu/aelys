"""Owner-only local projections of a separate read-only Google connection."""
from app.core.db import get_db
from app.core.security import current_principal
from app.domains.google_calendar_models import GoogleCalendarConnection
from app.domains.google_calendar_sync import (
    disconnect_google_calendar,
    sync_google_calendar,
)
from app.sync.change_log import lock_owner
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix='/calendar/google', tags=['google-calendar'])


class CalendarSyncOut(BaseModel):
    imported: int
    deleted: int
    full_sync: bool


class CalendarDisconnectOut(BaseModel):
    disconnected: bool


async def connection_for(db: AsyncSession, owner_id: str) -> GoogleCalendarConnection:
    connection=(await db.execute(select(GoogleCalendarConnection).where(
        GoogleCalendarConnection.owner_id==owner_id,GoogleCalendarConnection.deleted_at.is_(None),
        GoogleCalendarConnection.connection_status!='disconnected'))).scalar_one_or_none()
    if connection is None:
        raise HTTPException(404,detail={'code':'CALENDAR_NOT_CONNECTED','message':'Connect Google Calendar first'})
    return connection


@router.post('/sync', response_model=CalendarSyncOut)
async def sync_now(principal=Depends(current_principal),db: AsyncSession=Depends(get_db)):
    user,_=principal
    owner_id=user.id
    connection=await connection_for(db,owner_id)
    connection_id=connection.id
    await db.rollback()
    return await sync_google_calendar(connection_id,owner_id=owner_id,force=True)


@router.delete('/connection', response_model=CalendarDisconnectOut)
async def disconnect(principal=Depends(current_principal),db: AsyncSession=Depends(get_db)):
    user,_=principal
    await lock_owner(db,user.id)
    connection=await connection_for(db,user.id)
    await disconnect_google_calendar(db,connection)
    await db.commit()
    return {'disconnected':True}
