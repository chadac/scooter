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

    port: int = 8080


settings = BrokerSettings()
