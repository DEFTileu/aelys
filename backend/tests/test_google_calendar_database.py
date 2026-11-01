"""Actual SQLite/PostgreSQL import lease and atomic domain-log contracts."""
import asyncio
import json
from datetime import UTC, datetime

import pytest
from ai_automation import conftest as ai_contracts
from app.ai.crypto import encrypt_secret
from app.core import db as database
from app.core.models import CalendarEvent, SyncChange, SyncRecord, User
from app.domains import google_calendar_sync as calendar
from app.domains.google_calendar_models import (
    GoogleCalendarConnection,
    GoogleCalendarCredential,
)
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

calendar_test_engine = ai_contracts.ai_test_engine


async def test_real_database_serializes_parallel_import_and_disconnect(calendar_test_engine, monkeypatch):
    sessions=async_sessionmaker(calendar_test_engine,expire_on_commit=False)
    monkeypatch.setattr(database,'SessionLocal',sessions)
    at=datetime.now(UTC)
    async with sessions() as db:
        db.add(User(id='calendar-owner'));await db.flush()
        db.add(GoogleCalendarConnection(id='calendar-contract',owner_id='calendar-owner'));await db.flush()
        db.add(GoogleCalendarCredential(connection_id='calendar-contract',encrypted_tokens=encrypt_secret(json.dumps({
            'scope':'https://www.googleapis.com/auth/calendar.readonly','access_token':'synthetic-access','refresh_token':'synthetic-refresh','expires_at':4102444800}))))
        await db.commit()
    entered,release=asyncio.Event(),asyncio.Event()
    calls=[]
    async def provider(method,url,**kwargs):
        calls.append(method);entered.set();await release.wait()
        return {'items':[{'id':'remote','summary':'Database contract','start':{'dateTime':'2026-11-02T09:00:00Z'},'end':{'dateTime':'2026-11-02T10:00:00Z'}}],'nextSyncToken':'next-cursor'}
    monkeypatch.setattr(calendar,'google_calendar_request',provider)
    first=asyncio.create_task(calendar.sync_google_calendar('calendar-contract',owner_id='calendar-owner',at=at))
    try:
        await asyncio.wait_for(entered.wait(),5)
        with pytest.raises(HTTPException) as parallel:
            await calendar.sync_google_calendar('calendar-contract',owner_id='calendar-owner',at=at)
        assert parallel.value.detail['code']=='CALENDAR_SYNC_BUSY'
        with pytest.raises(HTTPException) as foreign:
            await calendar.sync_google_calendar('calendar-contract',owner_id='foreign',at=at)
        assert foreign.value.status_code==404
        release.set();assert (await first)['imported']==1
        assert calls==['GET']
        assert (await calendar.sync_google_calendar('calendar-contract',at=at))['imported']==0
        async with sessions() as db:
            event=(await db.execute(select(CalendarEvent))).scalar_one()
            record=(await db.execute(select(SyncRecord).where(SyncRecord.resource_id==event.id))).scalar_one()
            changes=(await db.execute(select(SyncChange).where(SyncChange.resource_id==event.id))).scalars().all()
            assert len(changes)==1 and event.version==record.version==changes[0].version==1
            connection=await db.get(GoogleCalendarConnection,'calendar-contract')
            await calendar.disconnect_google_calendar(db,connection);await db.commit()
            await db.refresh(event);await db.refresh(record)
            changes=(await db.execute(select(SyncChange).where(SyncChange.resource_id==event.id).order_by(SyncChange.seq))).scalars().all()
            assert event.deleted_at and event.version==record.version==2
            assert [row.operation for row in changes]==['create','delete']
            assert await db.get(GoogleCalendarCredential,connection.id) is None
    finally:
        release.set()
        if not first.done():await first
