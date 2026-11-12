"""Jira provider: the agent's Jira tools, calling the REST API with the Atlassian OAuth app's token.

Raw API access goes through contrib/atlassian's forge proxy, which also links
issues the agent creates.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.client_credentials import ClientCredentialsSource
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from .config import TOKEN_URL, JiraSettings
from .mcp_tools import jira_mcp_server


@register_provider
def jira() -> Provider:
    # Read at build time, like every provider factory.
    settings = JiraSettings()
    cloud_id = settings.atlassian_cloud_id
    return Provider(
        name="jira",
        credential=ClientCredentialsSource(
            token_url=TOKEN_URL,
            client_id=settings.atlassian_client_id,
            client_secret=settings.atlassian_client_secret,
        ),
        transports=[
            McpTools(server=jira_mcp_server(), upstream=f"https://api.atlassian.com/ex/jira/{cloud_id}"),
        ],
        enabled=bool(settings.atlassian_client_id and cloud_id),
    )
