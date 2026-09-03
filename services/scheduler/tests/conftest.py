"""Shared test fixtures.

SQLite has no migrations, so the test suite builds its schema from the ORM models.
On Postgres the Atlas migrations under lib/sql own the schema and the service issues
no DDL at all — which is why this lives here and not in the Store.
"""

from scheduler.models import Base
from scheduler.store import Store

SQLITE = "sqlite+aiosqlite:///:memory:"


async def sqlite_store() -> Store:
    """A Store on a fresh in-memory database, with its tables created."""
    store = Store(SQLITE)
    async with store._engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return store
