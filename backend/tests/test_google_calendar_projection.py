"""Real recurrence projection, including Google's exclusions and exceptions."""
from datetime import datetime

import pytest
from app.core.models import CalendarEvent
from app.domains import google_calendar_projection as projection


def dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


def event(event_id: str, *, start: str = '2026-03-07T09:00:00-05:00',
          end: str = '2026-03-07T10:00:00-05:00', metadata: dict | None = None,
          source: str | None = 'google_calendar:connection', deleted: bool = False,
          owner: str = 'owner', all_day: bool = False) -> CalendarEvent:
    return CalendarEvent(id=event_id, owner_id=owner, title=event_id, version=1,
        starts_at=dt(start), ends_at=dt(end), timezone='America/New_York',
        all_day=all_day, rrule=None, external_source=source, external_id=event_id,
        external_metadata=metadata or {}, deleted_at=dt('2026-03-01T00:00:00Z') if deleted else None)


def test_full_recurrence_set_exdate_rdate_moved_and_cancelled_instances():
    master = event('master', metadata={'recurrence': ['RRULE:FREQ=DAILY;COUNT=4',
        'EXDATE;TZID=America/New_York:20260308T090000',
        'RDATE;TZID=America/New_York:20260312T090000']})
    moved = event('moved', start='2026-03-09T12:00:00-04:00', end='2026-03-09T13:00:00-04:00',
        metadata={'recurring_event_id': 'master', 'original_start': '2026-03-09T13:00:00Z'})
    cancelled = event('cancelled', deleted=True, metadata={'recurring_event_id': 'master',
        'original_start': '2026-03-10T13:00:00Z'})
    values = projection.project_google_calendar_events([master, moved, cancelled],
        dt('2026-03-07T00:00:00Z'), dt('2026-03-14T00:00:00Z'))
    assert [(item.id, start.isoformat(), (end - start).total_seconds()) for item, start, end in values] == [
        ('master', '2026-03-07T14:00:00+00:00', 3600),
        ('moved', '2026-03-09T16:00:00+00:00', 3600),
        ('master', '2026-03-12T13:00:00+00:00', 3600),
    ]


def test_cancelled_master_hides_children_and_foreign_exception_never_suppresses():
    master = event('master', metadata={'recurrence': ['RRULE:FREQ=DAILY;COUNT=2']})
    foreign = event('foreign', owner='other', deleted=True,
        metadata={'recurring_event_id': 'master', 'original_start': '2026-03-07T14:00:00Z'})
    bounds = (dt('2026-03-07T00:00:00Z'), dt('2026-03-10T00:00:00Z'))
    assert len(projection.project_google_calendar_events([master, foreign], *bounds)) == 2
    master.deleted_at = dt('2026-03-01T00:00:00Z')
    child = event('child', metadata={'recurring_event_id': 'master', 'original_start': '2026-03-07T14:00:00Z'})
    assert projection.project_google_calendar_events([master, child], *bounds) == []


def test_all_day_preserves_local_dates_across_dst_and_date_exclusions():
    master = event('all-day', start='2026-03-07T00:00:00-05:00', end='2026-03-08T00:00:00-05:00',
        all_day=True, metadata={'recurrence': ['RRULE:FREQ=DAILY;COUNT=3',
            'EXDATE;VALUE=DATE:20260307', 'RDATE;VALUE=DATE:20260310']})
    values = projection.project_google_calendar_events([master], dt('2026-03-07T00:00:00Z'), dt('2026-03-12T00:00:00Z'))
    assert [(start.isoformat(), end.isoformat()) for _, start, end in values] == [
        ('2026-03-08T05:00:00+00:00', '2026-03-09T04:00:00+00:00'),
        ('2026-03-09T04:00:00+00:00', '2026-03-10T04:00:00+00:00'),
        ('2026-03-10T04:00:00+00:00', '2026-03-11T04:00:00+00:00'),
    ]


def test_nonexistent_dst_time_does_not_consume_rrule_count():
    master = event('gap', start='2026-03-07T02:30:00-05:00', end='2026-03-07T03:30:00-05:00',
        metadata={'recurrence': ['RRULE:FREQ=DAILY;COUNT=3']})
    values = projection.project_google_calendar_events([master], dt('2026-03-07T00:00:00Z'), dt('2026-03-12T00:00:00Z'))
    assert [start.isoformat() for _, start, _ in values] == [
        '2026-03-07T07:30:00+00:00', '2026-03-09T06:30:00+00:00', '2026-03-10T06:30:00+00:00']


def test_local_events_keep_existing_recurrence_and_overlap_bounds():
    local = event('local', source=None)
    local.rrule = 'FREQ=DAILY;COUNT=3'
    values = projection.project_google_calendar_events([local], dt('2026-03-08T13:30:00Z'), dt('2026-03-09T13:00:00Z'))
    assert [(start.isoformat(), end.isoformat()) for _, start, end in values] == [
        ('2026-03-08T13:00:00+00:00', '2026-03-08T14:00:00+00:00')]


def test_exrule_uses_dst_aware_count_and_remains_bounded(monkeypatch):
    master = event('exrule-gap', start='2026-03-07T02:30:00-05:00', end='2026-03-07T03:30:00-05:00',
        metadata={'recurrence': ['RRULE:FREQ=DAILY;COUNT=5', 'EXRULE:FREQ=DAILY;COUNT=2']})
    values = projection.project_google_calendar_events([master], dt('2026-03-07T00:00:00Z'), dt('2026-03-14T00:00:00Z'))
    assert [start.isoformat() for _, start, _ in values] == [
        '2026-03-10T06:30:00+00:00', '2026-03-11T06:30:00+00:00', '2026-03-12T06:30:00+00:00']
    master.external_metadata = {'recurrence': ['RRULE:FREQ=DAILY;COUNT=1',
        'RDATE;TZID=America/New_York:20260320T023000', 'EXRULE:FREQ=DAILY']}
    monkeypatch.setattr(projection, 'MAX_ITERATIONS', 3)
    with pytest.raises(ValueError, match='limit'):
        projection.project_google_calendar_events([master], dt('2026-03-20T00:00:00Z'), dt('2026-03-21T00:00:00Z'))


@pytest.mark.parametrize('kind', ['RRULE', 'EXRULE'])
@pytest.mark.parametrize('rule', ['FREQ=DAILY;COUNT=0', 'FREQ=DAILY;INTERVAL=0', 'FREQ=INVALID'])
def test_rule_and_exrule_invalid_syntax_rejected_before_import(kind, rule):
    with pytest.raises(ValueError):
        projection.validate_google_recurrence([f'{kind}:{rule}'], dt('2026-03-07T14:00:00Z'), 'America/New_York')


def test_projection_has_scan_and_result_limits(monkeypatch):
    master = event('bounded', metadata={'recurrence': ['RRULE:FREQ=DAILY']})
    monkeypatch.setattr(projection, 'MAX_ITERATIONS', 2)
    with pytest.raises(ValueError, match='limit'):
        projection.project_google_calendar_events([master], dt('2026-04-01T00:00:00Z'), dt('2026-04-02T00:00:00Z'))
    monkeypatch.setattr(projection, 'MAX_ITERATIONS', 100)
    monkeypatch.setattr(projection, 'MAX_OCCURRENCES', 1)
    with pytest.raises(ValueError, match='limit'):
        projection.project_google_calendar_events([master], dt('2026-03-07T00:00:00Z'), dt('2026-03-12T00:00:00Z'))
