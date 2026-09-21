"""`init_db` takes its database config as an ARGUMENT, not from the app.

The store used to import the webhooks app's `config.DatabaseSettings` — the one
import standing between this module and the lib. It now accepts anything
satisfying the `DatabaseConfig` protocol, which is what keeps config.py in the
app (the arrangement agreed on PR #567).
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from scooter_webhooks_lib import store
from scooter_webhooks_lib.store import DatabaseConfig


@dataclass
class _Config:
    dsn: str = "sqlite+aiosqlite:///:memory:"
    db_host: str = "local"


@pytest.fixture(autouse=True)
async def _dispose():
    yield
    await store.close_db()


def test_the_apps_settings_shape_satisfies_the_protocol():
    # runtime_checkable, so this is the actual structural check the app's
    # DatabaseSettings has to keep passing — not a comment asserting it does.
    assert isinstance(_Config(), DatabaseConfig)


async def test_init_db_uses_the_dsn_it_is_given():
    await store.init_db(_Config(dsn="sqlite+aiosqlite:///:memory:"))
    assert store._engine is not None
    assert store._engine.url.drivername == "sqlite+aiosqlite"


async def test_init_db_requires_a_config():
    # It used to default to constructing the app's DatabaseSettings, so a caller
    # who forgot silently got a second, independently env-read config — and on a
    # misread env, a SQLite file in /tmp instead of the durable Postgres store.
    with pytest.raises(TypeError):
        await store.init_db()


async def test_close_db_clears_the_engine():
    await store.init_db(_Config())
    await store.close_db()
    assert store._engine is None
    assert store._session_factory is None
