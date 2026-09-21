"""Shared settings base. Services subclass it; contribs construct it directly
instead of importing a service's config. Why: PR #572.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings


class ScooterBaseSettings(BaseSettings):
    """Config more than one service shares, plus the env-reading convention."""

    # Empty is a MODE, not a missing value: the agent-host clients treat a falsy
    # url as "off" (broker auto-linking in local/dev). Don't default it to a real
    # address — webhooks overrides instead. PR #572.
    agent_host_url: str = ""

    agent_host_token_path: str = "/var/run/secrets/agent-host/token"

    # Empty -> "View conversation" deep-links degrade to the raw id.
    agent_manager_url: str = ""

    # No prefix + case-insensitive: a field named `datadog_api_key` reads the
    # DATADOG_API_KEY the manifests already set. Inherited by every contrib.
    model_config = {"env_prefix": "", "case_sensitive": False}
