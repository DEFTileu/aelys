"""A single server task clock spans Telegram AI, REST and offline device edits."""
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

from app.ai import api as ai_api
from app.ai.models import ProviderKind, Usage
from app.core.models import HistoryEntry, SyncChange
from app.integrations import telegram_service as service
from sqlalchemy import select
from test_domain_sync_log import push_domain
from test_telegram_personal import bound, ordinary
from test_telegram_personal_dialogue import Service, provider

pytest_plugins=('test_telegram_business',)


async def test_task_clocks_and_history_survive_mixed_writers_and_offline_conflict(setup,monkeypatch):
    from app.integrations import telegram_personal_dialogue as dialogue
    client,sessions,fake,integration_id=await bound(setup)
    fake.updates=[ordinary(1,'/task Cross-channel task')];await service.poll_once(integration_id,timeout=0)
    created=(await client.get('/api/v1/tasks')).json()[0]
    assert created['started_at'] is None and created['completed_at'] is None
    await provider(sessions,integration_id)
    class Model(Service):
        calls=0
        async def complete(self,*args,**kwargs):
            self.calls+=1
            return SimpleNamespace(provider=ProviderKind.CLAUDE,model='test',
                response=SimpleNamespace(text='Готово' if self.calls>1 else '',tool_calls=({'id':'start-task','name':'update_task',
                    'input':{'task_id':created['id'],'version':1,'status':'in_progress'}},) if self.calls==1 else ()),
                usage=SimpleNamespace(usage=Usage(),estimated_cost=Decimal(0)))
    model=Model();monkeypatch.setattr(ai_api,'_service',lambda *a,**kw:model)
    fake.updates=[ordinary(2,'Измени задачу Cross-channel task: статус in_progress')]
    await service.poll_once(integration_id,timeout=0);await dialogue.personal_iteration(integration_id);await dialogue.wait_for_personal_turns()
    started=(await client.get('/api/v1/tasks/'+created['id'])).json()
    assert started['version']==2 and started['started_at'] and started['completed_at'] is None
    finished_response=await client.patch('/api/v1/tasks/'+created['id'],json={'title':created['title'],'status':'done','version':2})
    assert finished_response.status_code==200,finished_response.text
    finished=finished_response.json()
    assert finished['started_at']==started['started_at'] and finished['completed_at'] and finished['version']==3
    enrolled=(await client.post('/api/v1/devices/enroll',json={'platform':'web','display_name':'offline clock test'})).json()
    client.headers['Authorization']='Bearer '+enrolled['access_token']
    stale=await push_domain(client,enrolled['device_id'],'task',created['id'],'update',1,{'status':'todo','started_at':None,'completed_at':None})
    assert stale.status_code==200 and stale.json()['results'][0]['status']=='conflict'
    assert (await client.get('/api/v1/tasks/'+created['id'])).json()==finished
    reopened=await push_domain(client,enrolled['device_id'],'task',created['id'],'update',3,
        {'status':'todo','started_at':'2000-01-01T00:00:00Z','completed_at':'2000-01-01T00:00:00Z'})
    assert reopened.status_code==200,reopened.text
    assert reopened.json()['results'][0]['status']=='applied'
    current=(await client.get('/api/v1/tasks/'+created['id'])).json()
    assert current['version']==4 and current['completed_at'] is None and current['started_at']==started['started_at']
    pull=(await client.get('/api/v1/sync/pull')).json()
    latest=[change for change in pull['changes'] if change['resource_id']==created['id']][-1]
    assert latest['version']==4 and datetime.fromisoformat(latest['payload']['started_at'])==datetime.fromisoformat(current['started_at']) and latest['payload']['completed_at'] is None
    async with sessions() as db:
        history=(await db.execute(select(HistoryEntry).where(HistoryEntry.resource_id==created['id'],HistoryEntry.action=='task.status.changed'))).scalars().all()
        assert len(history)==3
        changes=(await db.execute(select(SyncChange).where(SyncChange.resource_id==created['id']).order_by(SyncChange.seq))).scalars().all()
        assert [change.version for change in changes]==[1,2,3,4]
