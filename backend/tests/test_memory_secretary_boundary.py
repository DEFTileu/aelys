"""Personal memory is not an input to the Business secretary at all."""
from app.integrations import telegram_ai

pytest_plugins=('test_telegram_ai',)


async def test_secretary_never_reads_or_receives_personal_memory(state,monkeypatch):
    from app.ai import memory
    db,item,target,calls,_=state
    await memory.remember(db,item.owner_id,'PRIVATE_OWNER_MEMORY customer question секрет',source='api')
    await db.commit()
    async def forbidden(*args,**kwargs):
        raise AssertionError('Secretary cannot access the personal memory selector')
    monkeypatch.setattr(memory,'select_relevant_facts',forbidden)
    result=await telegram_ai.generate_business_draft(db,item,target)
    assert result.action=='reply' and calls
    assert all('PRIVATE_OWNER_MEMORY' not in message.content for message in calls[0][2])
    assert not calls[0][3].get('tools')
