"""Imported calendars remain local read-only projections across every writer."""
from app.core.models import CalendarEvent, User
from app.sync.change_log import record_domain_change
from sqlalchemy import select
from test_domain_sync_log import push_domain

pytest_plugins=('test_domain_sync_log',)


async def imported(sessions):
    from datetime import UTC, datetime, timedelta
    async with sessions() as db:
        owner=(await db.execute(select(User.id))).scalar_one()
        item=CalendarEvent(owner_id=owner,title='Imported meeting',starts_at=datetime.now(UTC),ends_at=datetime.now(UTC)+timedelta(hours=1),
            timezone='UTC',external_source='google_calendar:synthetic',external_id='remote-1',external_metadata={})
        db.add(item);await db.flush();await record_domain_change(db,item);await db.commit()
        return item.id


async def test_external_event_cannot_be_edited_deleted_or_mutated_by_push(sync_domain_setup):
    client,sessions,device=sync_domain_setup
    event_id=await imported(sessions)
    event=(await client.get('/api/v1/calendar/events/'+event_id)).json()
    assert event['external_source']=='google_calendar:synthetic' and event['external_id']=='remote-1'
    patch=await client.patch('/api/v1/calendar/events/'+event_id,json={**event,'title':'Overwrite imported'})
    assert patch.status_code==409 and patch.json()['detail']['code']=='EXTERNAL_EVENT_READ_ONLY'
    deleted=await client.delete('/api/v1/calendar/events/'+event_id,params={'version':1})
    assert deleted.status_code==409
    push=await push_domain(client,device,'event',event_id,'update',1,{'title':'Offline overwrite'})
    assert push.status_code==409 or push.status_code==200
    if push.status_code==200:
        assert push.json()['results'][0]['status']!='applied'
    assert (await client.get('/api/v1/calendar/events/'+event_id)).json()==event


async def test_google_service_status_missing_credentials_is_honest(sync_domain_setup):
    client,_,_=sync_domain_setup
    response=await client.get('/api/v1/calendar/google/status')
    assert response.status_code==200
    assert response.json()['configured'] is False and response.json()['connection'] is None
    connected=await client.post('/api/v1/calendar/google/connect')
    assert connected.status_code==503 and connected.json()['detail']['code']=='CALENDAR_NOT_CONFIGURED'


async def test_local_event_idempotency_and_client_forged_external_fields_stay_local(sync_domain_setup):
    client,_,_=sync_domain_setup
    data={'title':'Local event','starts_at':'2026-11-04T10:00:00Z','ends_at':'2026-11-04T11:00:00Z',
        'external_source':'google_calendar:forged','external_id':'forged','external_metadata':{'recurrence':['RRULE:FREQ=DAILY']}}
    first=await client.post('/api/v1/calendar/events',json=data,headers={'Idempotency-Key':'local-calendar-idempotency'})
    second=await client.post('/api/v1/calendar/events',json=data,headers={'Idempotency-Key':'local-calendar-idempotency'})
    assert first.status_code==second.status_code==200,second.text
    assert first.json()==second.json() and first.json()['external_source'] is None


async def test_legacy_event_projection_defaults_do_not_duplicate_log_or_change_version(sync_domain_setup):
    from app.core.models import SyncChange, SyncRecord
    from app.sync.change_log import ensure_domain_projection
    client,sessions,_=sync_domain_setup
    event=(await client.post('/api/v1/calendar/events',json={'title':'Legacy local','starts_at':'2026-11-05T09:00:00Z','ends_at':'2026-11-05T10:00:00Z'})).json()
    async with sessions() as db:
        mirror=(await db.execute(select(SyncRecord).where(SyncRecord.resource_id==event['id']))).scalar_one()
        log=(await db.execute(select(SyncChange).where(SyncChange.resource_id==event['id']))).scalar_one()
        legacy={key:value for key,value in log.payload.items() if key not in {'external_source','external_id','external_metadata'}}
        mirror.payload=dict(legacy);log.payload=dict(legacy);await db.commit()
        await ensure_domain_projection(db,mirror.owner_id);await db.commit()
        changes=(await db.execute(select(SyncChange).where(SyncChange.resource_id==event['id']))).scalars().all()
        assert len(changes)==1 and changes[0].payload==legacy
        await db.refresh(mirror)
        assert mirror.version==1 and mirror.payload['external_metadata']=={} and mirror.payload['external_source'] is None


async def test_export_preserves_local_events_but_excludes_rebuildable_google_projections(sync_domain_setup):
    from datetime import UTC, datetime

    from app.core.export import build_owner_export
    from app.core.models import CalendarReminder
    client,sessions,_=sync_domain_setup
    external_id=await imported(sessions)
    local=(await client.post('/api/v1/calendar/events',json={'title':'Local backup','starts_at':'2026-11-05T09:00:00Z','ends_at':'2026-11-05T10:00:00Z'})).json()
    async with sessions() as db:
        owner=(await db.execute(select(User))).scalar_one()
        db.add(CalendarReminder(owner_id=owner.id,event_id=external_id,notify_at=datetime.now(UTC),occurrence_at=datetime.now(UTC),offset_seconds=60,idempotency_key='external-fixture'))
        await db.commit()
        exported=await build_owner_export(db,owner.email)
        assert [event['id'] for event in exported['tables']['calendar_events']]==[local['id']]
        assert exported['tables']['calendar_reminders']==[]
        assert not any(key.startswith('google_calendar_') for key in exported['tables'])


async def test_manual_sync_endpoint_releases_request_session_without_expiring_owner(sync_domain_setup):
    from app.domains.google_calendar_models import GoogleCalendarConnection
    client,sessions,_=sync_domain_setup
    async with sessions() as db:
        owner=(await db.execute(select(User.id))).scalar_one()
        db.add(GoogleCalendarConnection(owner_id=owner,connection_status='error'))
        await db.commit()
    result=await client.post('/api/v1/calendar/google/sync')
    assert result.status_code==409,result.text
    assert result.json()['detail']['code']=='CALENDAR_RECONNECT_REQUIRED'


async def test_disconnect_endpoint_removes_status_connection_and_imported_events(sync_domain_setup):
    from app.core.models import SyncChange
    from app.domains.google_calendar_models import GoogleCalendarConnection
    client,sessions,_=sync_domain_setup
    event_id=await imported(sessions)
    async with sessions() as db:
        owner=(await db.execute(select(User.id))).scalar_one()
        db.add(GoogleCalendarConnection(id='synthetic',owner_id=owner,connection_status='error'));await db.commit()
    assert (await client.get('/api/v1/calendar/google/status')).json()['connection']['id']=='synthetic'
    response=await client.delete('/api/v1/calendar/google/connection')
    assert response.status_code==200 and response.json()=={'disconnected':True}
    assert (await client.get('/api/v1/calendar/google/status')).json()['connection'] is None
    assert (await client.get('/api/v1/calendar/events/'+event_id)).status_code==404
    async with sessions() as db:
        change=(await db.execute(select(SyncChange).where(SyncChange.resource_id==event_id).order_by(SyncChange.seq.desc()).limit(1))).scalar_one()
        assert change.operation=='delete' and change.version==2


async def test_external_readonly_guard_precedes_local_only_rrule_body_validation(sync_domain_setup):
    client,sessions,_=sync_domain_setup
    event_id=await imported(sessions)
    async with sessions() as db:
        event=await db.get(CalendarEvent,event_id)
        event.rrule='FREQ=DAILY;COUNT=2;BYHOUR=9'
        event.external_metadata={'recurrence':['RRULE:'+event.rrule]};event.version+=1
        await record_domain_change(db,event);await db.commit()
    event=(await client.get('/api/v1/calendar/events/'+event_id)).json()
    assert event['external_source']
    edited=await client.patch('/api/v1/calendar/events/'+event_id,json={**event,'title':'No local edit'})
    assert edited.status_code==409 and edited.json()['detail']['code']=='EXTERNAL_EVENT_READ_ONLY'
