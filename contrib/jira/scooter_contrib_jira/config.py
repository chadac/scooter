"""Jira settings, owned by this contrib and shared by its broker and webhooks halves."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class JiraSettings(ScooterBaseSettings):
    # contribs.atlassian's OAuth app, shared with every Atlassian product.
    atlassian_client_id: str = ""
    atlassian_client_secret: str = ""
    atlassian_cloud_id: str = ""

    # The site base URL used to build a human /browse/{KEY} link; without it the auto-link falls back to the API `self` URL.
    jira_site_url: str = ""

    jira_enabled: bool = False
    jira_webhook_secret: str = ""
    # The agent's own Atlassian account id, whose comments come back as webhooks.
    jira_bot_account_id: str = ""


settings = JiraSettings()
