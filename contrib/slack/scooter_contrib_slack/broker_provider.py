"""Slack provider: the agent tools over a static bot token, plus file downloads via the forge proxy."""

from __future__ import annotations

from .config import SlackSettings
from scooter_broker_lib.forge import Decision, ForgeHost, ForgeHosts, ForgeRequest
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.mcp_tools import McpTools

from .awaiting_input import AwaitingInputNotice
from .mcp_tools import slack_mcp_server


UPSTREAM = "https://slack.com/api"

# Lets the agent download attachments the webhook skipped.
FILES_HOST = "files.slack.com"


class ReadOnly:
    """Allow only downloads from files.slack.com."""

    async def check(self, request: ForgeRequest) -> Decision:
        if request.host == FILES_HOST and request.is_mutation:
            return Decision.deny(f"{FILES_HOST} is read-only through Scooter")
        return Decision.allow()


@register_provider
def slack() -> Provider:
    # Read at build time, like every provider factory.
    settings = SlackSettings()
    return Provider(
        name="slack",
        credential=StaticTokenSource(token=settings.slack_bot_token),
        # Tools only; no raw slack.com/api path is served.
        transports=[
            AwaitingInputNotice(upstream=UPSTREAM),
            McpTools(server=slack_mcp_server(), upstream=UPSTREAM),
            ForgeHosts(hosts=[ForgeHost(FILES_HOST, api_prefixes=("/",))]),
        ],
        forge_policy=ReadOnly(),
        enabled=bool(settings.slack_bot_token),
    )
