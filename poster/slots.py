"""Posting slots: which scheduled time a run belongs to, so each slot is posted at most once.

A slot is identified by the UTC time it was scheduled for, e.g. 20261120T1630Z (10:00 PM IST).
The posted asset gets the tag tgbot_slot_<slot>. Any later run for the same slot sees the tag and
does not post again. This lets an on-time external trigger and GitHub's own (often late) schedule
run side by side: whichever arrives first posts, the other one stops.
"""

import re
from datetime import datetime, timedelta, timezone

SLOT_RE = re.compile(r"^\d{8}T\d{4}Z$")
CRON_RE = re.compile(r"^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$")
# An external trigger may fire a little before the slot time (clock differences). Within this
# margin a run counts for the upcoming slot instead of the previous one.
EARLY_TOLERANCE = timedelta(minutes=10)


class SlotError(ValueError):
    pass


def parse_times(spec: str) -> list[tuple[int, int]]:
    """'16:30,23:30' -> [(16, 30), (23, 30)] (UTC hours and minutes)."""
    times = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        match = re.fullmatch(r"(\d{1,2}):(\d{2})", part)
        if not match or int(match[1]) > 23 or int(match[2]) > 59:
            raise SlotError(f"POST_SLOTS_UTC must look like 16:30,23:30, got {part!r}")
        times.append((int(match[1]), int(match[2])))
    if not times:
        raise SlotError("POST_SLOTS_UTC is empty")
    return sorted(set(times))


def cron_time(cron: str) -> tuple[int, int]:
    """'30 16 * * *' -> (16, 30). Only daily schedules at a fixed time are supported."""
    match = CRON_RE.match(cron or "")
    if not match:
        raise SlotError(f"Unsupported schedule {cron!r}: only daily 'M H * * *' crons are supported")
    minute, hour = int(match[1]), int(match[2])
    if hour > 23 or minute > 59:
        raise SlotError(f"Invalid schedule {cron!r}")
    return hour, minute


def latest_occurrence(time_utc: tuple[int, int], now: datetime) -> datetime:
    """The most recent moment at or before `now` with this UTC hour and minute."""
    hour, minute = time_utc
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate > now:
        candidate -= timedelta(days=1)
    return candidate


def slot_id(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y%m%dT%H%MZ")


def slot_time(slot: str) -> datetime:
    return datetime.strptime(slot, "%Y%m%dT%H%MZ").replace(tzinfo=timezone.utc)


def resolve_slot(schedule_cron: str, requested: str, times: list[tuple[int, int]], now: float) -> str | None:
    """Work out the slot of this run.

    schedule_cron  the cron that started a scheduled GitHub run (github.event.schedule), or ''
    requested      '' (no slot: a manual one-off post), 'auto' (the slot due now), or an explicit slot ID
    """
    moment = datetime.fromtimestamp(now, tz=timezone.utc)
    if schedule_cron.strip():
        return slot_id(latest_occurrence(cron_time(schedule_cron), moment))
    requested = requested.strip()
    if not requested:
        return None
    if requested.lower() == "auto":
        return slot_id(max(latest_occurrence(t, moment + EARLY_TOLERANCE) for t in times))
    if SLOT_RE.match(requested):
        return requested
    raise SlotError(f"slot must be empty, 'auto' or like 20261120T1630Z, got {requested!r}")


def expected_slots(times: list[tuple[int, int]], since: datetime, until: datetime) -> list[str]:
    """Every slot ID scheduled in (since, until], oldest first."""
    result = []
    day = since.replace(hour=0, minute=0, second=0, microsecond=0)
    while day <= until:
        for hour, minute in times:
            moment = day.replace(hour=hour, minute=minute)
            if since < moment <= until:
                result.append(slot_id(moment))
        day += timedelta(days=1)
    return result
