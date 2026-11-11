"""Broker configuration: secrets and enable/disable flags, while providers own their upstream URLs."""

from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic_settings import BaseSettings

from scooter_lib.settings import ScooterBaseSettings

if TYPE_CHECKING:  # import at runtime would pull sqlalchemy into every config import
    from scooter_broker_lib.store import StoreConfig


class BrokerSettings(ScooterBaseSettings):
    # Auth
    token_audience: str = "agent-broker"
    # Seconds one TokenReview may take before the caller gets a 502.
    token_review_timeout_s: float = 5.0
    sandbox_namespace: str = "agent-sandbox"

    # SA usernames admitted as non-sandbox callers acting for a user (CSV of
    # system:serviceaccount:{ns}:{name}), which sets Identity.is_approver.
    approver_service_accounts: str = ""

    # SA usernames trusted to name a user in X-Scooter-User (CSV of
    # system:serviceaccount:{ns}:{name}): the agent-host, relaying a contrib settings
    # tab's /contrib-api call. Sets Identity.relayed_user; any other caller's header is
    # ignored.
    user_relay_service_accounts: str = ""

    # SA usernames that run system tasks (CSV of system:serviceaccount:{ns}:{name}): the
    # scheduler, whose tasks call a contrib's /system routes. Sets Identity.is_system_task.
    system_task_service_accounts: str = ""

    # --- The agent-facing MCP server (broker/mcp/) --------------------------
    # Contrib-contributed agent tools served at POST /mcp to one conversation at a time.
    mcp_enabled: bool = True

    # SA usernames allowed to act for a conversation by presenting a conversation token
    # (CSV of system:serviceaccount:{ns}:{name}), a separate authorization from
    # approver_service_accounts even though both name the agent-host.
    mcp_caller_service_accounts: str = ""

    # The HS256 secret the agent-host signs conversation tokens with; empty fails closed.
    conv_token_secret: str = ""

    # The HS256 secret the router signs user assertions with. When set, an approver SA's
    # relayed `approver` must come with an assertion vouching for it.
    user_assertion_secret: str = ""

    # The `test` whoami provider, off in prod.
    test_provider_enabled: bool = False

    # --- The shared `broker` database ---------------------------------------
    # Components for the platform Postgres database named `broker`, which every broker
    # store uses; the SQLite default is the dev path and a set password wins (see store_config).
    broker_db_dsn: str = "sqlite+aiosqlite:////tmp/broker.db"
    broker_db_host: str = "agent-shared-db.agent-manager.svc.cluster.local"
    broker_db_port: int = 5432
    broker_db_user: str = "broker"
    broker_db_password: str = ""
    broker_db_name: str = "broker"
    broker_db_sslmode: str = ""  # e.g. "require" for RDS; empty means no ssl param
    # --- OpenFGA authorization --------------------------------------------
    # Off by default, which selects the NoopAuthorizer.
    fga_enabled: bool = False
    fga_api_url: str = ""             # e.g. http://openfga.agent-manager.svc:8080
    fga_store_id: str = ""
    fga_authorization_model_id: str = ""

    # --- Sandbox-adjacent settings --------------------------------------------
    # A mounted directory of `.nix` files served unauthenticated as the deployment's
    # default modules at GET /modules/default.tar.gz; empty serves an empty tarball.
    sandbox_default_modules_dir: str = ""

    # --- The forge egress proxy (broker/forge/) --------------------------------
    # Sandboxes reach git/gh/glab hosts through this CONNECT proxy, which injects the provider credential.
    forge_proxy_port: int = 3128

    port: int = 8080

    def store_config(self, dsn: str = "") -> "StoreConfig":
        """The shared-Postgres components as a StoreConfig, where `dsn` is the store's own dev-SQLite default that loses to Postgres whenever a password is set."""
        from scooter_broker_lib.store import StoreConfig

        return StoreConfig(
            dsn=dsn or self.broker_db_dsn,
            db_host=self.broker_db_host,
            db_port=self.broker_db_port,
            db_user=self.broker_db_user,
            db_password=self.broker_db_password,
            db_name=self.broker_db_name,
            db_sslmode=self.broker_db_sslmode,
        )


# The process-wide settings snapshot, which `refresh_settings()` updates in place.
settings = BrokerSettings()


def get_settings() -> BrokerSettings:
    """A fresh BrokerSettings read from the current environment."""
    return BrokerSettings()


def refresh_settings() -> BrokerSettings:
    """Re-read the environment into the shared `settings` object in place and return it."""
    fresh = BrokerSettings()
    settings.__dict__.update(fresh.__dict__)
    return settings
