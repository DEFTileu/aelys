from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.db import get_db
from app.core.models import AutomationExecution, AutomationRule, Notification, Task
from app.core.security import current_principal

router=APIRouter()
class RuleIn(BaseModel):
    name:str=Field(min_length=1,max_length=200); trigger_kind:str; conditions:dict={}; actions:list[dict]=[]; policy_ref:str; rate_limit:dict={}; enabled:bool=True
class EventIn(BaseModel): event_id:str; event_kind:str; payload:dict={}
@router.get("/automations")
async def list_rules(principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; return list((await db.execute(select(AutomationRule).where(AutomationRule.owner_id==user.id,AutomationRule.deleted_at.is_(None)))).scalars())
@router.post("/automations")
async def create_rule(body:RuleIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=AutomationRule(owner_id=user.id,name=body.name,trigger_kind=body.trigger_kind,conditions_json=body.conditions,actions_json=body.actions,policy_ref=body.policy_ref,rate_limit_json=body.rate_limit,enabled=body.enabled); db.add(item); await db.commit(); await db.refresh(item); return item
@router.patch("/automations/{rule_id}")
async def update_rule(rule_id:str,body:dict,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AutomationRule,rule_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Rule not found"})
    for key in ("name","enabled","trigger_kind","policy_ref"):
        if key in body:setattr(item,key,body[key])
    await db.commit(); return item
@router.delete("/automations/{rule_id}")
async def delete_rule(rule_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AutomationRule,rule_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Rule not found"})
    item.deleted_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc); item.enabled=False; await db.commit(); return {"deleted":True}
@router.get("/automations/{rule_id}/executions")
async def executions(rule_id:str,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AutomationRule,rule_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Rule not found"})
    return list((await db.execute(select(AutomationExecution).where(AutomationExecution.rule_id==rule_id).order_by(AutomationExecution.started_at.desc()))).scalars())
@router.post("/automations/{rule_id}/dry-run")
async def dry_run(rule_id:str,body:EventIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; item=await db.get(AutomationRule,rule_id)
    if not item or item.owner_id!=user.id: raise HTTPException(404,detail={"code":"NOT_FOUND","message":"Rule not found"})
    matches=item.enabled and item.trigger_kind==body.event_kind and all(body.payload.get(k)==v for k,v in item.conditions_json.items())
    return {"rule_id":rule_id,"event_id":body.event_id,"would_execute":matches,"actions":item.actions_json if matches else []}
@router.post("/automations/dispatch")
async def dispatch(body:EventIn,principal=Depends(current_principal),db:AsyncSession=Depends(get_db)):
    user,_=principal; rules=list((await db.execute(select(AutomationRule).where(AutomationRule.owner_id==user.id,AutomationRule.enabled.is_(True),AutomationRule.trigger_kind==body.event_kind))).scalars()); results=[]
    for rule in rules:
        prior=(await db.execute(select(AutomationExecution).where(AutomationExecution.owner_id==user.id,AutomationExecution.rule_id==rule.id,AutomationExecution.event_id==body.event_id))).scalar_one_or_none()
        if prior: results.append({"rule_id":rule.id,"status":"duplicate"}); continue
        if not all(body.payload.get(k)==v for k,v in rule.conditions_json.items()): continue
        execution=AutomationExecution(owner_id=user.id,rule_id=rule.id,event_id=body.event_id,run_status="running"); db.add(execution); await db.flush()
        try:
            for action in rule.actions_json:
                kind=action.get("kind") or action.get("tool")
                args=action.get("args",action.get("arguments",{}))
                if kind=="create_task":
                    db.add(Task(owner_id=user.id,title=str(args.get("title",body.payload.get("title","Automated task"))),description=str(args.get("description","")),project_id=args.get("project_id",body.payload.get("project_id"))))
                elif kind=="create_notification":
                    db.add(Notification(owner_id=user.id,kind=str(args.get("kind","automation")),title=str(args.get("title","Automation")),body=str(args.get("body","")),data_json={"event_id":body.event_id}))
                else:
                    raise HTTPException(403,detail={"code":"POLICY_DENIED","message":f"Automation action is not allowlisted: {kind}"})
            execution.run_status="completed"; results.append({"rule_id":rule.id,"status":"completed"})
        except HTTPException:
            execution.run_status="failed"; execution.error_code="POLICY_DENIED"; raise
    await db.commit(); return {"event_id":body.event_id,"results":results}
