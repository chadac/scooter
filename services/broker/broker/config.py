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
    # Store DSN components (shared Postgres; SQLite default). Mirrors webhooks.
    aws_db_dsn: str = "sqlite+aiosqlite:////tmp/broker-aws.db"
    aws_db_host: str = "agent-webhooks-db.agent-manager.svc.cluster.local"
    aws_db_port: int = 5432
    aws_db_user: str = "webhooks"
    aws_db_password: str = ""
    aws_db_name: str = "broker"
    # Notify the agent-host when a request is created so it raises the approval
    # interrupt. Empty = no notify (local/dev).
    aws_agent_host_url: str = ""
    # Sweep interval (seconds) for expired dynamic roles.
    aws_sweep_interval: int = 300

    port: int = 8080


settings = BrokerSettings()
