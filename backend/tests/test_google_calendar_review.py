"""Review reproduction: Google supports EXRULE in event recurrence sets."""
from datetime import datetime

import pytest
from app.domains import google_calendar_sync as sync
from app.domains.google_calendar_models import (
    GoogleCalendarConnection,
    GoogleCalendarCredential,
)
from app.domains.google_calendar_projection import project_google_calendar_events
from sqlalchemy import select
from test_google_calendar_oauth import SCOPE, begin, finish, google_stub
from test_google_calendar_sync import AT, remote, rows

pytest_plugins = ('test_google_calendar_sync', 'test_google_calendar_oauth')


async def test_google_exrule_import_and_projection_excludes_matching_occurrence(calendar_sync_setup):
    # Google Events explicitly permits RRULE, EXRULE, RDATE and EXDATE lines.
    # This series is Mon/Tue/Wed; the EXRULE removes Tuesday.
    calendar_sync_setup.pages[:] = [{'items': [remote('exrule-master', recurrence=[
        'RRULE:FREQ=DAILY;COUNT=3', 'EXRULE:FREQ=WEEKLY;BYDAY=TU',
    ])], 'nextSyncToken': 'exrule-cursor'}]
    result = await sync.sync_google_calendar('connection', owner_id='owner', at=AT)
    assert result == {'imported': 1, 'deleted': 0, 'full_sync': True}
    projected = project_google_calendar_events(await rows(calendar_sync_setup),
        datetime.fromisoformat('2026-11-02T00:00:00Z'), datetime.fromisoformat('2026-11-05T00:00:00Z'))
    assert [start.isoformat() for _, start, _ in projected] == [
        '2026-11-02T14:00:00+00:00', '2026-11-04T14:00:00+00:00',
    ]


@pytest.mark.parametrize('phase', ['token', 'profile'])
async def test_disconnect_during_consumed_oauth_callback_cannot_revive_connection(calendar_client, monkeypatch, phase):
    from app.domains import google_calendar_oauth as oauth
    google_stub(monkeypatch)
    query, _ = await begin(calendar_client)
    assert (await finish(calendar_client, query)).status_code == 303
    query, _ = await begin(calendar_client)
    async def request(method, url, **kwargs):
        if (method == 'POST') == (phase == 'token'):
            # The callback has consumed/committed its state, but has not yet
            # received its token response. Disconnect explicitly revokes access.
            async with calendar_client.sessions() as db:
                connection = (await db.execute(select(GoogleCalendarConnection))).scalar_one()
                await sync.disconnect_google_calendar(db, connection)
                await db.commit()
        if method == 'POST':
            return {'access_token': 'late-access', 'refresh_token': 'late-refresh', 'scope': SCOPE}
        return {'id': 'primary@example.test', 'timeZone': 'UTC'}
    monkeypatch.setattr(oauth, 'google_calendar_request', request)
    response = await finish(calendar_client, query)
    assert response.status_code == 409
    async with calendar_client.sessions() as db:
        connection = (await db.execute(select(GoogleCalendarConnection))).scalar_one()
        assert connection.connection_status == 'disconnected'
        assert await db.get(GoogleCalendarCredential, connection.id) is None


async def test_parallel_first_oauth_callbacks_cannot_overwrite_first_connected_identity(calendar_client, monkeypatch):
    import json

    from app.ai.crypto import decrypt_secret
    from app.domains import google_calendar_oauth as oauth

    first, _ = await begin(calendar_client)
    second, _ = await begin(calendar_client)
    nested = False
    async def request(method, url, **kwargs):
        nonlocal nested
        if method == 'POST':
            if not nested:
                nested = True
                assert (await finish(calendar_client, second)).status_code == 303
                return {'access_token': 'first-access', 'refresh_token': 'first-refresh', 'scope': SCOPE}
            return {'access_token': 'second-access', 'refresh_token': 'second-refresh', 'scope': SCOPE}
        identity = 'second' if kwargs['headers']['Authorization'] == 'Bearer second-access' else 'first'
        return {'id': identity + '@example.test', 'timeZone': 'UTC'}
    monkeypatch.setattr(oauth, 'google_calendar_request', request)
    response = await calendar_client.client.get('/api/v1/calendar/google/callback',
        params={'state': first['state'][0], 'code': 'first-code'}, headers={'Cookie': f'{oauth.COOKIE}={first["state"][0]}'})
    assert response.status_code == 409
    async with calendar_client.sessions() as db:
        connection = (await db.execute(select(GoogleCalendarConnection))).scalar_one()
        assert connection.calendar_id == 'second@example.test'
        credential = await db.get(GoogleCalendarCredential, connection.id)
        assert json.loads(decrypt_secret(credential.encrypted_tokens))['refresh_token'] == 'second-refresh'
