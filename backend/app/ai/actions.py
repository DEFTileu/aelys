"""Shared approval of server-stored actions; sources invalidate pending rows separately."""
from __future__ import annotations

from datetime import UTC, datetime

from app.core.models import AIAction
from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from .errors import PolicyDenied, ToolValidationError, redact_error
from .models import PermissionContext, ToolCall


async def owned_action(db: AsyncSession, owner_id: str, action_id: str) -> AIAction:
    action = await db.get(AIAction, action_id, populate_existing=True)
    if not action or action.owner_id != owner_id:
        raise HTTPException(404, detail={'code': 'NOT_FOUND', 'message': 'Action not found'})
    return action


async def approve_action(db: AsyncSession, owner_id: str, action_id: str) -> AIAction:
    action = await owned_action(db, owner_id, action_id)
    if action.status == 'rejected':
        raise HTTPException(409, detail={'code': 'ACTION_REJECTED', 'message': 'This action was rejected'})
    if action.status != 'pending':
        return action
    # An invalidator races on this row only; approval never reads connector data.
    claimed = await db.execute(update(AIAction).where(
        AIAction.id == action_id, AIAction.owner_id == owner_id, AIAction.status == 'pending',
    ).values(status='approved').returning(AIAction.id).execution_options(synchronize_session=False))
    if claimed.scalar_one_or_none() is None:
        await db.rollback()
        await db.refresh(action)
        return action
    # The claim may have waited for a row lock. Check the current clock only
    # after acquiring it, before any tool or domain mutation runs.
    expired = await db.execute(update(AIAction).where(
        AIAction.id == action_id, AIAction.owner_id == owner_id, AIAction.status == 'approved',
        AIAction.expires_at <= datetime.now(UTC),
    ).values(status='failed', result_json={'error': {'code': 'ACTION_EXPIRED', 'message': 'Action expired'}})
        .returning(AIAction.id).execution_options(synchronize_session=False))
    if expired.scalar_one_or_none() is not None:
        await db.commit()
        await db.refresh(action)
        return action
    from .personal_tools import personal_tool_registry
    registry = personal_tool_registry(db, owner_id, action.id)
    call = ToolCall(action.tool, action.arguments_json or {}, action.id)
    project_id = (action.arguments_json or {}).get('project_id')
    try:
        context = PermissionContext(actor=f'owner:{owner_id}', scopes=frozenset({registry.descriptor(action.tool).required_scope}),
                                    project_ids=frozenset({str(project_id)}) if project_id is not None else frozenset(), policy_id='ai-action-approval')
        result = dict(await registry.invoke(call, context))
        await db.execute(update(AIAction).where(AIAction.id == action_id, AIAction.owner_id == owner_id)
                         .values(result_json=jsonable_encoder(result)))
        await db.commit()
    except (PolicyDenied, ToolValidationError, RuntimeError) as error:
        await db.rollback()
        code = 'POLICY_DENIED' if isinstance(error, PolicyDenied) else 'VALIDATION_ERROR' if isinstance(error, ToolValidationError) else 'TOOL_ERROR'
        await db.execute(update(AIAction).where(
            AIAction.id == action_id, AIAction.owner_id == owner_id, AIAction.status == 'pending',
        ).values(status='failed', result_json={'error': {'code': code, 'message': redact_error(error)}}))
        await db.commit()
    await db.refresh(action)
    return action


async def reject_action(db: AsyncSession, owner_id: str, action_id: str) -> AIAction:
    action = await owned_action(db, owner_id, action_id)
    if action.status == 'pending':
        await db.execute(update(AIAction).where(
            AIAction.id == action_id, AIAction.owner_id == owner_id, AIAction.status == 'pending',
        ).values(status='rejected'))
        await db.commit()
        await db.refresh(action)
    if action.status != 'rejected':
        raise HTTPException(409, detail={'code': 'ACTION_NOT_PENDING', 'message': f'This action is already {action.status}'})
    return action
