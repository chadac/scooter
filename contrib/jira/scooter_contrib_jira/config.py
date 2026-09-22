"""Jira settings, owned by this contrib rather than the two apps.

Same env vars both services read before (ATLASSIAN_CLIENT_ID / _SECRET /
_CLOUD_ID, JIRA_SITE_URL, JIRA_ENABLED, JIRA_WEBHOOK_SECRET,
JIRA_BOT_ACCOUNT_ID), so a deployment needs no manifest change. Why: PR #582.
"""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class JiraSettings(ScooterBaseSettings):
    # Atlassian OAuth — the broker proxies /jira/* with a token minted from these.
    atlassian_client_id: str = ""
    atlassian_client_secret: str = ""
    atlassian_cloud_id: str = ""

    # The Jira SITE base URL (e.g. https://acme.atlassian.net). Used to build a
    # human /browse/{KEY} link for an issue the agent creates; without it the
    # auto-link falls back to the API `self` URL.
    jira_site_url: str = ""

    # Webhooks side.
    jira_enabled: bool = False
    jira_webhook_secret: str = ""
    # The agent's own Atlassian account id — its comments come back as webhooks.
    jira_bot_account_id: str = ""


settings = JiraSettings()
