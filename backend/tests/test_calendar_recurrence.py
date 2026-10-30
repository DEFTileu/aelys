from datetime import datetime

from app.domains.recurrence import occurrences


def dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


def test_monthly_rrule_omits_missing_monthday():
    values = occurrences(dt('2026-01-31T09:00:00+00:00'), dt('2026-01-31T10:00:00+00:00'), 'UTC', 'FREQ=MONTHLY;COUNT=3', dt('2026-01-01T00:00:00+00:00'), dt('2026-06-01T00:00:00+00:00'))
    assert [value[0].date().isoformat() for value in values] == ['2026-01-31', '2026-03-31', '2026-05-31']


def test_nonexistent_dst_time_does_not_consume_count():
    values = occurrences(dt('2026-03-07T02:30:00-05:00'), dt('2026-03-07T03:30:00-05:00'), 'America/New_York', 'FREQ=DAILY;COUNT=3', dt('2026-03-07T00:00:00Z'), dt('2026-03-12T00:00:00Z'))
    assert [value[0].isoformat() for value in values] == ['2026-03-07T07:30:00+00:00', '2026-03-09T06:30:00+00:00', '2026-03-10T06:30:00+00:00']
