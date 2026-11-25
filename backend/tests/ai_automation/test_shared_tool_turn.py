"""One reusable bounded tool turn, including repeated tool-call protection."""
import json
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
    assert result.followup_pending


async def test_unknown_tool_is_returned_to_model_as_validation_error():
    from app.ai.turn import run_tool_turn
    registry = ToolRegistry(ServerPolicyEngine())
    class Service:
        calls = 0
        async def complete(self, run_id, request, messages, **kwargs):
            self.calls += 1
            if self.calls == 2:
                assert 'unknown tool' in messages[-1].content
            return SimpleNamespace(provider=SimpleNamespace(value='claude'), model='test',
                response=SimpleNamespace(text='done' if self.calls == 2 else '',
                    tool_calls=({'id':'x','name':'unknown','input':{}},) if self.calls == 1 else ()),
                usage=SimpleNamespace(usage=Usage(), estimated_cost=Decimal(0)))
    result = await run_tool_turn(Service(), uuid4(), RoutingRequest(TaskKind.TOOL_ACTION),
        (ChatMessage('user', 'hello'),), registry, PermissionContext(actor='owner'),
        parse_call=lambda raw: ToolCall(raw['name'], raw['input'], raw['id']))
    assert result.text == 'done'


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


async def test_openrouter_loads_schemas_between_completions_only():
    from app.ai.api import _tool_call
    from app.ai.execution import AIExecutionService
    from app.ai.models import Capability, ModelSpec, ProviderKind
    from app.ai.providers import HttpResponse, OpenRouterAdapter
    from app.ai.secrets import AuthenticatedStreamCipher, SecretRef, SecretStore
    from app.ai.turn import run_tool_turn

    registry = ToolRegistry(ServerPolicyEngine())
    writes = []

    async def create_event(args):
        writes.append(args["title"])
        return {"id": "event-1"}

    async def read(_args):
        return {"items": []}

    for name in ("list_tasks", "read_calendar", "read_note", "search_notes", "search_knowledge",
                 "read_chat_history", "create_reminder"):
        registry.register(ToolDescriptor(name, name, "permitted", dict, read))
    registry.register(ToolDescriptor("create_event", "Create event", "permitted", dict, create_event))
    registry.register(ToolDescriptor("web_search", "Search the web", "permitted", dict, read, external_effect=True))

    class Transport:
        def __init__(self):
            self.requests = []

        async def post(self, _url, *, headers, json):
            self.requests.append(json)
            message = replies[len(self.requests) - 1]
            return HttpResponse(200, {"choices": [{"message": message}]})

    def call(name, call_id, **arguments):
        return {"id": call_id, "type": "function", "function": {
            "name": name, "arguments": json.dumps(arguments),
        }}

    replies = [
        {"content": None, "tool_calls": [
            call("load_tools", "load", names=["create_event", "create_reminder"]),
            call("create_event", "early", title="Too soon"),
        ]},
        {"content": None, "tool_calls": [call("create_event", "create", title="Review")]},
        {"content": "Scheduled the review."},
        {"content": "Hello."},
    ]
    transport = Transport()
    store = SecretStore(AuthenticatedStreamCipher(b"x" * 32))
    ref = SecretRef("provider", "test")
    store.put(ref, "synthetic-provider-credential")
    adapter = OpenRouterAdapter(transport, store, ref, "https://provider.invalid")
    model = ModelSpec(ProviderKind.OPENROUTER, "test", frozenset({Capability.TOOL_CALLING}),
                      10000, Decimal(0), Decimal(0))
    service = AIExecutionService([model], {ProviderKind.OPENROUTER: adapter})
    context = PermissionContext(actor="owner", scopes=frozenset({"permitted"}))
    request = RoutingRequest(TaskKind.TOOL_ACTION)
    result = await run_tool_turn(service, uuid4(), request, (ChatMessage("user", "Schedule the review"),),
                                 registry, context, parse_call=_tool_call)
    assert result.text == "Scheduled the review." and writes == ["Review"]
    await run_tool_turn(service, uuid4(), request, (ChatMessage("user", "Hello"),),
                        registry, context, parse_call=_tool_call)
    first, second, _, next_turn = transport.requests
    assert "web_search" not in {tool["function"]["name"] for tool in first["tools"]}
    assert first["tools"] == next_turn["tools"]
    assert second["tools"][:len(first["tools"])] == first["tools"]
    assert [tool["function"]["name"] for tool in second["tools"][len(first["tools"]):]] == [
        "create_reminder", "create_event",
    ]
    selection, early = second["messages"][-2:]
    assert selection["tool_call_id"] == "load" and '"loaded"' in selection["content"]
    assert early["tool_call_id"] == "early" and "TOOL_NOT_LOADED" in early["content"]


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
