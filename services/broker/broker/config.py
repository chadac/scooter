"""Broker configuration — secrets + enable/disable only.

Providers own their upstream URLs; config supplies the secrets they need and
which providers are active. Modeled on openhands-nix config.py (pydantic
BaseSettings), restructured per-provider.

Design stage: shape only.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings


class BrokerSettings(BaseSettings):
    # Auth
    token_audience: str = "agent-broker"
    sandbox_namespace: str = "agent-sandbox"

    # GitHub (App preferred; PAT fallback)
    github_app_id: str = ""
    github_app_private_key: str = ""
    github_app_installation_id: int = 0
    github_token: str = ""

    # GitLab / Slack (static tokens)
    gitlab_token: str = ""
    slack_bot_token: str = ""

    # Jira / Atlassian OAuth
    atlassian_client_id: str = ""
    atlassian_client_secret: str = ""
    atlassian_cloud_id: str = ""

    # Datadog (two-key header auth: DD-API-KEY + DD-APPLICATION-KEY). The provider
    # proxies /datadog/* -> https://api.<site> with both keys injected, so the
    # agent can query metrics/logs/monitors WITHOUT seeing the keys. Enabled iff
    # BOTH keys are set. `site` is region-specific (datadoghq.com | datadoghq.eu |
    # us3.datadoghq.com | us5.datadoghq.com | ap1.datadoghq.com | ddog-gov.com).
    datadog_api_key: str = ""
    datadog_app_key: str = ""
    datadog_site: str = "datadoghq.com"

    # Test/diagnostic provider (the `test` whoami provider). OFF in prod.
    test_provider_enabled: bool = False

    # --- AWS permissions broker (broker/aws/) ------------------------------
    aws_enabled: bool = False
    aws_region: str = "us-east-1"
    aws_sts_external_id: str = "agent-permissions-broker"
    # The broker's own IRSA role ARN — the principal the dynamic roles trust.
    aws_broker_principal_arn: str = ""
    # Path to the account-registry JSON (a mounted ConfigMap): alias ->
    # {account_id, broker_role_arn, enabled, allowed_policy?, allowed_managed_policies?, region?}.
    aws_accounts_file: str = ""
    aws_role_ttl_hours: int = 12
    # Which identity claim authorizes an approver (must match how the FGA approver
    # tuples are seeded). "email" | "id" | "name". Default email.
    aws_approver_claim: str = "email"
    # Store DSN components (shared Postgres; SQLite default). Mirrors webhooks.
    aws_db_dsn: str = "sqlite+aiosqlite:////tmp/broker-aws.db"
    aws_db_host: str = "agent-shared-db.agent-manager.svc.cluster.local"
    aws_db_port: int = 5432
    aws_db_user: str = "webhooks"
    aws_db_password: str = ""
    aws_db_name: str = "broker"
    # SA usernames allowed to APPROVE/DENY (the agent-host relays the user's pick
    # after validating it in-conversation). CSV of
    # system:serviceaccount:{ns}:{name}. Default: the agent-host.
    aws_approver_service_accounts: str = ""
    # Notify the agent-host when a request is created so it raises the approval
    # interrupt. Empty = no notify (local/dev).
    aws_agent_host_url: str = ""
    # Sweep interval (seconds) for expired dynamic roles.
    aws_sweep_interval: int = 300

    # --- OpenFGA authorization (broker = the policy enforcement point) ------
    # Off by default -> NoopAuthorizer -> the broker behaves as before. When on,
    # the per-account approver gate on approve/deny is enforced via OpenFGA.
    fga_enabled: bool = False
    fga_api_url: str = ""             # e.g. http://openfga.agent-manager.svc:8080
    fga_store_id: str = ""
    fga_authorization_model_id: str = ""

    port: int = 8080


# The process-wide settings snapshot. Most code reads `config.settings` directly.
# It's instantiated at import time, which is fine in prod (env is fixed before
# the app starts) but BRITTLE in tests: a test that sets an env var (e.g.
# TEST_PROVIDER_ENABLED) AFTER this module was first imported would otherwise be
# ignored. `refresh_settings()` re-reads the environment and updates this object
# IN PLACE so existing `from ..config import settings` references see the new
# values; `discover_providers()` calls it so provider factories always build
# against current env. See get_settings() for a fresh, non-mutating read.
settings = BrokerSettings()


def get_settings() -> BrokerSettings:
    """A fresh BrokerSettings read from the CURRENT environment (no caching)."""
    return BrokerSettings()


def refresh_settings() -> BrokerSettings:
    """Re-read env into the shared `settings` object in place, so module-level
    `settings` references (provider factories, etc.) pick up the current env.
    Returns the shared object. Idempotent; cheap."""
    fresh = BrokerSettings()
    settings.__dict__.update(fresh.__dict__)
    return settings
