"""A deployment that asks for TLS to Postgres must actually get it.

The kubenix module emits AWS_DB_SSLMODE from `agentSandbox.postgres.sslmode` (both
emission sites in modules/broker.nix), but BrokerSettings had no matching field, so
pydantic dropped the variable and every broker store — aws permission requests, the
module registry, static shares — opened a cleartext connection to a server the
deployment had asked to reach over TLS. Nothing failed; the setting was simply not
there. Webhooks and the scheduler both honour their own db_sslmode, which is what
made the gap invisible: the pattern looked already handled.

These assert the WHOLE path (env -> settings -> StoreConfig -> DSN) and that every
store gets it, since the bug was a component silently missing at three separate call
sites that each assembled their own StoreConfig.
"""

from __future__ import annotations

import pytest

from broker.aws.store import StoreConfig
from broker.config import BrokerSettings


def test_sslmode_reaches_the_dsn_as_asyncpgs_ssl_param():
    # asyncpg takes `ssl=`, not libpq's `sslmode=` — same mapping webhooks uses.
    cfg = StoreConfig(db_password="pw", db_sslmode="require")
    assert cfg.resolved_dsn().endswith("?ssl=require")


def test_no_ssl_param_when_unset():
    assert "ssl" not in StoreConfig(db_password="pw").resolved_dsn()


def test_sqlite_dev_dsn_is_untouched_by_sslmode():
    # No password -> the explicit dev DSN wins, and an ssl param would break it.
    cfg = StoreConfig(dsn="sqlite+aiosqlite:///:memory:", db_sslmode="require")
    assert cfg.resolved_dsn() == "sqlite+aiosqlite:///:memory:"


def test_env_var_the_module_emits_is_read(monkeypatch):
    monkeypatch.setenv("AWS_DB_SSLMODE", "require")
    monkeypatch.setenv("AWS_DB_PASSWORD", "pw")
    assert BrokerSettings().store_config().resolved_dsn().endswith("?ssl=require")


@pytest.mark.parametrize("dsn_setting", ["registry_db_dsn", "shares_db_dsn", ""])
def test_every_store_gets_the_same_components(monkeypatch, dsn_setting):
    """aws (no dsn override), registry and shares all assemble through one place."""
    monkeypatch.setenv("AWS_DB_SSLMODE", "require")
    monkeypatch.setenv("AWS_DB_PASSWORD", "pw")
    monkeypatch.setenv("AWS_DB_HOST", "pg.example")
    settings = BrokerSettings()
    dsn = settings.store_config(
        dsn=getattr(settings, dsn_setting) if dsn_setting else "").resolved_dsn()
    assert dsn == "postgresql+asyncpg://webhooks:pw@pg.example:5432/broker?ssl=require"
