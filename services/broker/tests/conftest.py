"""Shared test helpers.

SQLite has no migrations, so the test suite builds its schema from the ORM models.
On Postgres the Atlas migrations under lib/sql own the schema and the services issue
no DDL at all — which is why this lives here and not in a store's init().

Importable as `from conftest import ...` because pyproject sets pythonpath = ["tests"].
"""

from sqlalchemy.orm import DeclarativeBase

from broker.aws.store import StoreConfig

SQLITE = "sqlite+aiosqlite:///:memory:"


def sqlite_config(**kw) -> StoreConfig:
    """A StoreConfig pointed at a fresh in-memory SQLite database."""
    return StoreConfig(dsn=SQLITE, **kw)


async def create_schema(store, base: type[DeclarativeBase]) -> None:
    """Create `base`'s tables on the store's engine. SQLite only, by construction:
    a Postgres store would be a test reaching for DDL that the migrations own."""
    engine = store._engine
    assert engine.dialect.name == "sqlite", (
        f"create_schema is SQLite-only; got {engine.dialect.name!r}. "
        "On Postgres the lib/sql migrations own the schema."
    )
    async with engine.begin() as conn:
        await conn.run_sync(base.metadata.create_all)
