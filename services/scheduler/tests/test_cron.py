"""Tier 1 — the pure cron next-fire computation (the highest-value scheduler unit)."""

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from scheduler.cron import next_run, validate, InvalidSchedule


def test_next_run_daily_utc():
    # '0 9 * * *' = 09:00 daily. From 08:00 UTC → 09:00 same day.
    after = datetime(2026, 7, 24, 8, 0, tzinfo=ZoneInfo("UTC"))
    nxt = next_run("0 9 * * *", "UTC", after)
    assert nxt == datetime(2026, 7, 24, 9, 0, tzinfo=ZoneInfo("UTC"))


def test_next_run_is_strictly_after():
    # Exactly at the fire time → the NEXT occurrence (never returns `after` itself),
    # so a task fired at T doesn't immediately re-fire at T.
    after = datetime(2026, 7, 24, 9, 0, tzinfo=ZoneInfo("UTC"))
    nxt = next_run("0 9 * * *", "UTC", after)
    assert nxt == datetime(2026, 7, 25, 9, 0, tzinfo=ZoneInfo("UTC"))


def test_next_run_respects_timezone():
    # '0 9 * * *' in America/New_York = 9am EDT = 13:00 UTC (summer). Result is UTC.
    after = datetime(2026, 7, 24, 8, 0, tzinfo=ZoneInfo("UTC"))
    nxt = next_run("0 9 * * *", "America/New_York", after)
    assert nxt == datetime(2026, 7, 24, 13, 0, tzinfo=ZoneInfo("UTC"))


def test_next_run_weekday_only():
    # '0 9 * * 1-5' = weekdays. From a Saturday → the following Monday 09:00.
    sat = datetime(2026, 7, 25, 10, 0, tzinfo=ZoneInfo("UTC"))  # 2026-07-25 is a Saturday
    nxt = next_run("0 9 * * 1-5", "UTC", sat)
    assert nxt == datetime(2026, 7, 27, 9, 0, tzinfo=ZoneInfo("UTC"))  # Monday


def test_next_run_accepts_naive_after_as_utc():
    naive = datetime(2026, 7, 24, 8, 0)  # no tzinfo → treated as UTC
    nxt = next_run("0 9 * * *", "UTC", naive)
    assert nxt == datetime(2026, 7, 24, 9, 0, tzinfo=ZoneInfo("UTC"))
    assert nxt.tzinfo is not None  # always returns aware UTC


def test_validate_rejects_bad_cron():
    with pytest.raises(InvalidSchedule):
        validate("not a cron", "UTC")


def test_validate_rejects_bad_timezone():
    with pytest.raises(InvalidSchedule):
        validate("0 9 * * *", "Mars/Olympus_Mons")


def test_validate_accepts_good():
    validate("*/15 * * * *", "America/Los_Angeles")  # no raise
