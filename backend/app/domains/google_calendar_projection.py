"""Bounded, transient recurrence projection for local and imported calendars."""
from collections.abc import Iterable, Iterator
from datetime import datetime, time, timedelta
from itertools import islice
from zoneinfo import ZoneInfo

from app.core.models import CalendarEvent
from dateutil.rrule import rrule, rruleset, rrulestr  # type: ignore[import-untyped]

from .recurrence import MAX_ITERATIONS, MAX_OCCURRENCES, occurrences, utc


def _valid_rule_starts(line: str, start: datetime, zone: ZoneInfo) -> Iterator[datetime]:
    fields = dict(part.split('=', 1) for part in line.split(':', 1)[1].split(';'))
    count = int(fields['COUNT']) if 'COUNT' in fields else None
    if count is not None and count < 1:
        raise ValueError('Invalid recurrence count')
    if int(fields.get('INTERVAL', '1')) < 1 or ('COUNT' in fields and 'UNTIL' in fields):
        raise ValueError('Invalid recurrence interval or end')
    text = ';'.join(f'{key}={value}' for key, value in fields.items() if key != 'COUNT')
    values = rrulestr(text, dtstart=start, tzids=ZoneInfo)
    if not isinstance(values, rrule):
        raise TypeError('Invalid recurrence rule')
    valid = 0
    for index, value in enumerate(islice(values, MAX_ITERATIONS + 1)):
        if index >= MAX_ITERATIONS:
            raise ValueError('Recurrence scan limit exceeded')
        if utc(value).astimezone(zone).replace(tzinfo=None) != value.replace(tzinfo=None):
            continue
        valid += 1
        if count is not None and valid > count:
            return
        yield value


def _recurrence_dates(line: str, zone: ZoneInfo) -> list[datetime]:
    header, values = line.split(':', 1)
    parameters = dict(part.split('=', 1) for part in header.split(';')[1:])
    if set(parameters) - {'TZID', 'VALUE'} or parameters.get('VALUE', 'DATE-TIME') not in {'DATE', 'DATE-TIME'}:
        raise ValueError('Unsupported recurrence date')
    date_zone = ZoneInfo(parameters['TZID']) if 'TZID' in parameters else zone
    result = []
    for value in values.split(','):
        parsed = datetime.fromisoformat(value)
        result.append(parsed.replace(tzinfo=date_zone) if parsed.tzinfo is None else parsed)
    return result


def _recurrence_set(lines: list[str], start: datetime, zone: ZoneInfo) -> rruleset:
    if len(lines) > 100 or sum(len(line) for line in lines) > 20_000:
        raise ValueError('Recurrence metadata limit exceeded')
    result = rruleset()
    result.rdate(start)
    for line in lines:
        if not isinstance(line, str) or len(line) > 2000 or '\n' in line or '\r' in line:
            raise ValueError('Invalid recurrence line')
        kind = line.split(':', 1)[0].split(';', 1)[0]
        if kind in {'RRULE', 'EXRULE'}:
            # Parse eagerly so an invalid fetched page cannot be committed.
            rule_text = line.split(':', 1)[1]
            fields = dict(part.split('=', 1) for part in rule_text.split(';'))
            if (int(fields.get('COUNT', '1')) < 1 or int(fields.get('INTERVAL', '1')) < 1
                    or ('COUNT' in fields and 'UNTIL' in fields)):
                raise ValueError('Invalid recurrence count, interval or end')
            parsed = rrulestr(rule_text, dtstart=start, tzids=ZoneInfo)
            if not isinstance(parsed, rrule):
                raise ValueError('Invalid recurrence rule')
            (result.rrule if kind == 'RRULE' else result.exrule)(_valid_rule_starts(line, start, zone))
        elif kind in {'RDATE', 'EXDATE'}:
            for value in _recurrence_dates(line, zone):
                (result.rdate if kind == 'RDATE' else result.exdate)(value)
        else:
            raise ValueError('Unsupported recurrence line')
    return result


def validate_google_recurrence(lines: list[str], start: datetime, timezone_name: str) -> None:
    """Validate syntax without expanding an unbounded external recurrence."""
    zone = ZoneInfo(timezone_name)
    _recurrence_set(lines, utc(start).astimezone(zone), zone)


def _google_occurrences(event: CalendarEvent, lower: datetime, upper: datetime) -> Iterator[tuple[datetime, datetime]]:
    zone = ZoneInfo(event.timezone)
    start, end = utc(event.starts_at), utc(event.ends_at)
    local_start = start.astimezone(zone)
    lines = event.external_metadata.get('recurrence', [])
    if not isinstance(lines, list):
        raise TypeError('Invalid recurrence metadata')
    if not lines and event.rrule:
        lines = ['RRULE:' + event.rrule.removeprefix('RRULE:')]
    values = _recurrence_set(lines, local_start, zone)
    duration = end - start
    days = (end.astimezone(zone).date() - local_start.date()).days
    if duration <= timedelta(0) or (event.all_day and days < 1):
        raise ValueError('Invalid event duration')
    for index, value in enumerate(islice(values, MAX_ITERATIONS + 1)):
        if index >= MAX_ITERATIONS:
            raise ValueError('Recurrence scan limit exceeded')
        instant = utc(value)
        if instant >= upper:
            break
        if instant.astimezone(zone).replace(tzinfo=None) != value.replace(tzinfo=None):
            continue
        finish = (datetime.combine(value.astimezone(zone).date() + timedelta(days=days), time.min, zone)
                  .astimezone(instant.tzinfo)) if event.all_day else instant + duration
        if finish > lower:
            yield instant, finish


def project_google_calendar_events(events: list[CalendarEvent], lower: datetime,
                                   upper: datetime) -> list[tuple[CalendarEvent, datetime, datetime]]:
    """Callers supply all owner rows, including deleted exception placeholders.

    Matching includes owner and source so foreign exceptions cannot shadow a
    series. No projected instance is persisted or given an independent identity.
    """
    lower, upper = utc(lower), utc(upper)
    if upper <= lower:
        return []
    masters: dict[tuple[str, str | None, str | None], CalendarEvent] = {
               (event.owner_id, event.external_source, event.external_id): event for event in events
               if event.external_source and event.external_source.startswith('google_calendar:')}
    excluded: dict[tuple[str, str | None, str | None], set[datetime]] = {}
    for event in events:
        if not event.external_source or not event.external_source.startswith('google_calendar:'):
            continue
        metadata = event.external_metadata or {}
        parent, original = metadata.get('recurring_event_id'), metadata.get('original_start')
        if parent and original:
            key = (event.owner_id, event.external_source, parent)
            excluded.setdefault(key, set()).add(utc(datetime.fromisoformat(original)))
    result: list[tuple[CalendarEvent, datetime, datetime]] = []
    intervals: Iterable[tuple[datetime, datetime]]
    for event in events:
        if event.deleted_at:
            continue
        external = bool(event.external_source and event.external_source.startswith('google_calendar:'))
        parent = (event.external_metadata or {}).get('recurring_event_id') if external else None
        if parent:
            master = masters.get((event.owner_id, event.external_source, parent))
            if master is not None and master.deleted_at:
                continue
            intervals = [(utc(event.starts_at), utc(event.ends_at))]
        elif external:
            intervals = _google_occurrences(event, lower, upper)
        else:
            intervals = occurrences(event.starts_at, event.ends_at, event.timezone, event.rrule, lower, upper)
        suppressed = excluded.get((event.owner_id, event.external_source, event.external_id), set())
        for start, end in intervals:
            if start < upper and end > lower and start not in suppressed:
                result.append((event, start, end))
                if len(result) > MAX_OCCURRENCES:
                    raise ValueError('Occurrence limit exceeded; choose a smaller window')
    return sorted(result, key=lambda item: (item[1], item[0].id))
