"""One reusable bounded tool turn, including repeated tool-call protection."""
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

from app.ai.models import (
    ChatMessage,
    PermissionContext,
    RoutingRequest,
    TaskKind,
    ToolCall,
    Usage,
)
from app.ai.policy import ServerPolicyEngine
from app.ai.tools import ToolDescriptor, ToolRegistry


async def test_shared_tool_turn_continues_with_untrusted_results_once():
    from app.ai.turn import run_tool_turn
    registry = ToolRegistry(ServerPolicyEngine())
    writes = []
    async def save(args):
        writes.append(args['title'])
        return {'id': 'one', 'title': args['title']}
    registry.register(ToolDescriptor('create_task', 'Create', 'tasks.write', lambda x: x, save))
    calls = []
    class Service:
        async def complete(self, run_id, request, messages, **kwargs):
            calls.append(messages)
            return SimpleNamespace(provider=SimpleNamespace(value='claude'), model='test',
                response=SimpleNamespace(text='' if len(calls)==1 else 'Готово',
                    tool_calls=({'id': 'stable', 'name': 'create_task', 'input': {'title': 'Task'}},) if len(calls)==1 else ()),
                usage=SimpleNamespace(usage=Usage(10, 3), estimated_cost=Decimal('0.1')))
    events = []
    async def event(kind, payload):
        events.append((kind, payload))
    result = await run_tool_turn(Service(), uuid4(), RoutingRequest(TaskKind.TOOL_ACTION, request_budget=Decimal(1)),
        (ChatMessage('user', 'Создай задачу'),), registry,
        PermissionContext(actor='test', scopes=frozenset({'tasks.write'})),
        parse_call=lambda raw: ToolCall(raw['name'], raw['input'], raw['id']), on_event=event)
    assert result.text == 'Готово' and writes == ['Task'] and len(calls) == 2
    assert result.cost == Decimal('0.2') and result.input_tokens == 20
    assert calls[1][-1].untrusted and 'one' in calls[1][-1].content
    assert len([event for event in events if event[0] == 'ai.tool.result']) == 1


async def test_shared_turn_duplicate_call_id_never_replays_write():
    from app.ai.turn import run_tool_turn
    writes = []
    registry = ToolRegistry(ServerPolicyEngine())
    async def save(args):
        writes.append(True)
        return {'id': 'one'}
    registry.register(ToolDescriptor('create_task', 'Create', 'tasks.write', lambda x: x, save))
    class Service:
        async def complete(self, *args, **kwargs):
            return SimpleNamespace(provider=SimpleNamespace(value='claude'), model='test',
                response=SimpleNamespace(text='Готово', tool_calls=({'id':'same','name':'create_task','input':{}},)),
                usage=SimpleNamespace(usage=Usage(), estimated_cost=Decimal(0)))
    result = await run_tool_turn(Service(), uuid4(), RoutingRequest(TaskKind.TOOL_ACTION),
        (ChatMessage('user','Создай задачу'),), registry, PermissionContext(actor='test', scopes=frozenset({'tasks.write'})),
        parse_call=lambda raw: ToolCall(raw['name'],raw['input'],raw['id']))
    assert writes == [True] and result.steps == 2


async def test_real_usage_tracker_charges_each_provider_completion():
    from app.ai.execution import AIExecutionService
    from app.ai.models import Capability, ModelSpec, ProviderKind, ProviderResponse
    from app.ai.turn import run_tool_turn
    registry=ToolRegistry(ServerPolicyEngine())
    async def read(args):return {'items':[]}
    registry.register(ToolDescriptor('list_tasks','List','tasks.read',lambda x:x,read))
    class Adapter:
        calls=0
        async def complete(self,request):
            self.calls+=1
            return ProviderResponse('done' if self.calls==3 else '',Usage(100*self.calls,0),
                tool_calls=({'id':str(self.calls),'name':'list_tasks','input':{}},) if self.calls<3 else ())
    adapter=Adapter()
    model=ModelSpec(ProviderKind.CLAUDE,'test',frozenset({Capability.TOOL_CALLING}),10000,Decimal(1),Decimal(0))
    service=AIExecutionService([model],{ProviderKind.CLAUDE:adapter})
    result=await run_tool_turn(service,uuid4(),RoutingRequest(TaskKind.TOOL_ACTION,request_budget=Decimal(1)),
        (ChatMessage('user','List tasks'),),registry,PermissionContext(actor='test',scopes=frozenset({'tasks.read'})),
        parse_call=lambda r:ToolCall(r['name'],r['input'],r['id']))
    assert result.input_tokens==600 and result.cost==Decimal('0.6')
    assert len(service.usage.records())==3


async def test_monthly_budget_includes_failed_and_running_checkpoints(ai_test_engine):
    from datetime import UTC, datetime, timedelta

    from app.ai.api import _remaining_monthly_budget
    from app.core.db import Base
    from app.core.models import AIConversation, AIProvider, AIRun, User
    from sqlalchemy.ext.asyncio import async_sessionmaker
    async with ai_test_engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory=async_sessionmaker(ai_test_engine,expire_on_commit=False)
    at=datetime.now(UTC)
    old=at.replace(day=1,hour=0,minute=0,second=0,microsecond=0)-timedelta(days=1)
    async with factory() as db:
        db.add(User(id='budget-owner'));await db.flush()
        provider=AIProvider(id='budget-provider',owner_id='budget-owner',kind='claude',enabled=True,model_policy_json={'monthly_budget':'1'})
        conversation=AIConversation(id='budget-conversation',owner_id='budget-owner')
        db.add_all([provider,conversation]);await db.flush()
        for key,status,cost,when in [('failed','failed','0.7',at),('running','running','0.2',at),('old','completed','0.8',old)]:
            db.add(AIRun(id=key,owner_id='budget-owner',conversation_id=conversation.id,provider_id=provider.id,
                provider='claude',model='test',status=status,cost_estimate=Decimal(cost),started_at=when,
                completed_at=when if status!='running' else None,created_at=when,updated_at=when))
        await db.commit()
        assert await _remaining_monthly_budget(db,'budget-owner',provider)==Decimal('0.1')
