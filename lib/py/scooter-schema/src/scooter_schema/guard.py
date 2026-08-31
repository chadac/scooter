"""Runtime ownership guard: assert a connection is pointed at the database this
service owns, so a mis-wired DSN fails fast at startup instead of writing into
another database's tables. NOT generated.
"""

from __future__ import annotations

DATABASES = ("webhooks", "scheduler", "broker", "byoc")


def check_database(actual: str, expected: str) -> None:
    """Raise if ``actual`` (the connected database) is not ``expected``. Pure —
    the testable core the async/sync helpers below wrap."""
    if actual != expected:
        raise RuntimeError(
            f'scooter_schema: connected to database "{actual}" but this service owns '
            f'"{expected}" — refusing to run. Check the DSN\'s database name.'
        )


async def assert_database(conn, expected: str) -> None:
    """Assert an async SQLAlchemy connection is on ``expected``. ``conn`` is an
    ``AsyncConnection`` (e.g. ``async with engine.connect() as conn``)."""
    from sqlalchemy import text

    result = await conn.execute(text("select current_database()"))
    check_database(result.scalar_one(), expected)


def assert_database_sync(conn, expected: str) -> None:
    """Assert a sync SQLAlchemy connection is on ``expected``."""
    from sqlalchemy import text

    result = conn.execute(text("select current_database()"))
    check_database(result.scalar_one(), expected)
