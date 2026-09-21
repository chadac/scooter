"""DatabaseSettings DSN assembly — Postgres from components vs SQLite default."""

from webhooks.config import DatabaseSettings


def test_default_is_sqlite(monkeypatch):
    for k in ("DSN", "DB_PASSWORD", "DB_HOST", "DB_USER", "DB_NAME"):
        monkeypatch.delenv(k, raising=False)
    assert DatabaseSettings().dsn.startswith("sqlite")


def test_db_password_assembles_postgres_dsn(monkeypatch):
    monkeypatch.delenv("DSN", raising=False)
    monkeypatch.setenv("DB_PASSWORD", "s3cr3t")
    monkeypatch.setenv("DB_HOST", "agent-shared-db.agent-manager.svc.cluster.local")
    monkeypatch.setenv("DB_USER", "webhooks")
    monkeypatch.setenv("DB_NAME", "webhooks")
    dsn = DatabaseSettings().dsn
    assert dsn == (
        "postgresql+asyncpg://webhooks:s3cr3t@"
        "agent-shared-db.agent-manager.svc.cluster.local:5432/webhooks"
    )


def test_explicit_postgres_dsn_wins_over_components(monkeypatch):
    # An explicit Postgres DSN must not be clobbered by component assembly.
    monkeypatch.setenv("DSN", "postgresql+asyncpg://u:p@h:5432/db")
    monkeypatch.setenv("DB_PASSWORD", "ignored")
    assert DatabaseSettings().dsn == "postgresql+asyncpg://u:p@h:5432/db"


# --- the agent-host fields now come from scooter_lib ------------------------


def test_webhooks_settings_carries_the_shared_agent_host_fields():
    from scooter_lib.settings import ScooterBaseSettings

    from webhooks.config import WebhooksSettings

    assert issubclass(WebhooksSettings, ScooterBaseSettings)


def test_webhooks_keeps_its_in_cluster_agent_host_default(monkeypatch):
    # Deliberate override: "" means "auto-linking off" to the broker, but a
    # misconfiguration here. Collapsing the two silently breaks one.
    monkeypatch.delenv("AGENT_HOST_URL", raising=False)

    from webhooks.config import WebhooksSettings

    assert (
        WebhooksSettings().agent_host_url
        == "http://agent-host.agent-sandbox.svc.cluster.local:8080"
    )


def test_webhooks_agent_host_url_still_reads_its_env_var(monkeypatch):
    monkeypatch.setenv("AGENT_HOST_URL", "http://agent-host:9999")

    from webhooks.config import WebhooksSettings

    assert WebhooksSettings().agent_host_url == "http://agent-host:9999"


def test_agent_manager_url_survives_the_move_to_the_lib(monkeypatch):
    monkeypatch.setenv("AGENT_MANAGER_URL", "https://scooter.example.test")

    from webhooks.config import WebhooksSettings

    assert WebhooksSettings().agent_manager_url == "https://scooter.example.test"
