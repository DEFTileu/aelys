"""Bounded local-calendar recurrence projection; never creates duplicate events."""
from collections.abc import Iterator
from datetime import UTC, datetime
from itertools import islice
from zoneinfo import ZoneInfo

from dateutil.rrule import rrulestr

MAX_ITERATIONS = 50_000
MAX_OCCURRENCES = 1_000


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def parse_rule(value: str, starts_at: datetime, timezone_name: str):
    zone = ZoneInfo(timezone_name)
    text = value.removeprefix('RRULE:').upper()
    if not text or len(text) > 500 or '\n' in text or '\r' in text:
        raise ValueError('Supply one RRULE of at most 500 characters')
    parts = text.split(';')
    fields = dict(part.split('=', 1) for part in parts)
    if len(fields) != len(parts) or fields.get('FREQ') not in {'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'}:
        raise ValueError('Supported recurrence frequencies: DAILY, WEEKLY, MONTHLY, YEARLY')
    if any(key in fields for key in ('BYSECOND', 'BYMINUTE', 'BYHOUR')):
        raise ValueError('Sub-day recurrence selectors are not supported')
    if int(fields.get('INTERVAL', '1')) < 1 or int(fields.get('COUNT', '1')) < 1:
        raise ValueError('INTERVAL and COUNT must be positive')
    if 'COUNT' in fields and 'UNTIL' in fields:
        raise ValueError('Use COUNT or UNTIL, not both')
    return rrulestr(text, dtstart=utc(starts_at).astimezone(zone))


def recurrence_starts(starts_at: datetime, timezone_name: str, rule: str | None) -> Iterator[datetime]:
    if not rule:
        yield utc(starts_at)
        return
    zone = ZoneInfo(timezone_name)
    values = parse_rule(rule, starts_at, timezone_name)
    fields = dict(part.split('=', 1) for part in rule.removeprefix('RRULE:').upper().split(';'))
    count = int(fields['COUNT']) if 'COUNT' in fields else None
    if count:
        values = values.replace(count=None)
    valid_count = 0
    for index, value in enumerate(islice(values, MAX_ITERATIONS + 1)):
        if index >= MAX_ITERATIONS:
            raise ValueError('Recurrence scan limit exceeded; shorten the series')
        instant = utc(value)
        # RFC 5545: a nonexistent local time must not consume COUNT.
        if instant.astimezone(zone).replace(tzinfo=None) != value.replace(tzinfo=None):
            continue
        valid_count += 1
        if count and valid_count > count:
            return
        yield instant


def occurrences(starts_at: datetime, ends_at: datetime, timezone_name: str, rule: str | None,
                window_start: datetime, window_end: datetime) -> list[tuple[datetime, datetime]]:
    """Keep start wall time across DST and preserve the event's elapsed duration."""
    start, end, lower, upper = map(utc, (starts_at, ends_at, window_start, window_end))
    duration = end - start
    result: list[tuple[datetime, datetime]] = []
    for instant in recurrence_starts(start, timezone_name, rule):
        if instant >= upper:
            break
        finish = instant + duration
        if finish > lower:
            result.append((instant, finish))
            if len(result) > MAX_OCCURRENCES:
                raise ValueError('Occurrence limit exceeded; choose a smaller window')
    return result


def next_occurrence(starts_at: datetime, timezone_name: str, rule: str | None, after: datetime) -> datetime | None:
    return next((value for value in recurrence_starts(starts_at, timezone_name, rule) if value > utc(after)), None)
