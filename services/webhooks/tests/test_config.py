"""DatabaseSettings DSN assembly — Postgres from components vs SQLite default."""

from webhooks.config import DatabaseSettings


def test_default_is_sqlite(monkeypatch):
    for k in ("DSN", "DB_PASSWORD", "DB_HOST", "DB_USER", "DB_NAME"):
        monkeypatch.delenv(k, raising=False)
    assert DatabaseSettings().dsn.startswith("sqlite")


def test_db_password_assembles_postgres_dsn(monkeypatch):
    monkeypatch.delenv("DSN", raising=False)
    monkeypatch.setenv("DB_PASSWORD", "s3cr3t")
    monkeypatch.setenv("DB_HOST", "agent-webhooks-db.agent-manager.svc.cluster.local")
    monkeypatch.setenv("DB_USER", "webhooks")
    monkeypatch.setenv("DB_NAME", "webhooks")
    dsn = DatabaseSettings().dsn
    assert dsn == (
        "postgresql+asyncpg://webhooks:s3cr3t@"
        "agent-webhooks-db.agent-manager.svc.cluster.local:5432/webhooks"
    )


def test_explicit_postgres_dsn_wins_over_components(monkeypatch):
    # An explicit Postgres DSN must not be clobbered by component assembly.
    monkeypatch.setenv("DSN", "postgresql+asyncpg://u:p@h:5432/db")
    monkeypatch.setenv("DB_PASSWORD", "ignored")
    assert DatabaseSettings().dsn == "postgresql+asyncpg://u:p@h:5432/db"
