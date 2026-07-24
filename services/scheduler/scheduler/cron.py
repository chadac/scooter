"""Cron scheduling — the pure next-fire-time computation.

Standard 5-field cron + an IANA timezone. Uses croniter. This module is pure (no
I/O), so it's the highest-value unit test: it decides WHEN every task fires.
"""

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter


class InvalidSchedule(ValueError):
    """A cron expression or timezone that can't be parsed. The API maps this to 422."""


def validate(cron: str, timezone: str) -> None:
    """Raise InvalidSchedule if `cron` isn't a valid 5-field cron or `timezone`
    isn't a known IANA zone. Call on task create/update before persisting."""
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise InvalidSchedule(f"unknown timezone {timezone!r}") from e
    if not croniter.is_valid(cron):
        raise InvalidSchedule(f"invalid cron expression {cron!r}")


def next_run(cron: str, timezone: str, after: datetime) -> datetime:
    """The next fire time STRICTLY after `after`, evaluated in `timezone`, returned
    as a timezone-aware UTC datetime (the store's next_run_at is tz-aware UTC).

    `after` may be naive (assumed UTC) or aware. croniter evaluates the cron in the
    task's local zone so '0 9 * * *' means 9am local across DST, then we normalize
    the result to UTC for storage/comparison.
    """
    validate(cron, timezone)
    tz = ZoneInfo(timezone)
    # Anchor croniter in the task's local wall-clock so cron fields are local.
    base = _to_aware_utc(after).astimezone(tz)
    it = croniter(cron, base)
    return it.get_next(datetime).astimezone(ZoneInfo("UTC"))


def _to_aware_utc(dt: datetime) -> datetime:
    """A naive datetime is treated as UTC; an aware one is converted to UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=ZoneInfo("UTC"))
    return dt.astimezone(ZoneInfo("UTC"))
