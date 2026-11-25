from datetime import UTC, datetime

import pytest
from app.ai import chat_support
from app.integrations.telegram_guest import _guest_system_prompt


@pytest.mark.parametrize('zone,at,start,end', [
    ('Asia/Almaty', datetime(2026, 11, 25, 11, 18, tzinfo=UTC), '2026-11-24T00:00:00+05:00', '2026-11-25T00:00:00+05:00'),
    ('America/New_York', datetime(2026, 11, 2, 12, tzinfo=UTC), '2026-11-01T00:00:00-04:00', '2026-11-02T00:00:00-05:00'),
    ('America/New_York', datetime(2026, 3, 9, 12, tzinfo=UTC), '2026-03-08T00:00:00-05:00', '2026-03-09T00:00:00-04:00'),
    ('Invalid/Zone', datetime(2026, 11, 25, tzinfo=UTC), '2026-11-24T00:00:00+00:00', '2026-11-25T00:00:00+00:00'),
])
def test_trusted_local_day_bounds(zone, at, start, end):
    result = chat_support.trusted_time_context(zone, at=at)
    assert f'Yesterday: [{start}, {end})' in result
    if zone == 'Invalid/Zone':
        assert 'timezone UTC' in result


@pytest.mark.parametrize('unlocked', [False, True])
def test_guest_has_server_date_without_inheriting_app_policy(monkeypatch, unlocked):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 25, 11, 18, tzinfo=UTC).astimezone(tz)
    monkeypatch.setattr(chat_support, 'datetime', Clock)
    prompt = _guest_system_prompt('Asia/Almaty', tools_unlocked=unlocked)
    assert '2026-11-25T16:18:00+05:00' in prompt
    assert '2026-11-24T00:00:00+05:00' in prompt
    assert 'Other participants' in prompt and 'untrusted data' in prompt
    assert 'approval card' not in prompt
    assert ('Personal modules' in prompt) == (not unlocked)
    assert ('completed_at' in prompt) == unlocked


@pytest.mark.parametrize('channel', ['app', 'telegram', 'voice'])
def test_shared_channels_have_grounding_and_time(channel):
    prompt = chat_support.system_prompt('Invalid/Zone', tools=True, channel=channel)
    assert 'timezone UTC' in prompt and 'Current owner time:' in prompt
    assert 'not historical status' in prompt and 'next_offset' in prompt


@pytest.mark.parametrize('channel', ['app', 'telegram', 'voice'])
def test_no_tools_prompt_does_not_advertise_write_access(channel):
    prompt = chat_support.system_prompt('UTC', tools=False, channel=channel)
    assert 'No data sources' in prompt or 'No personal data tools' in prompt
    assert 'Perform a write' not in prompt
