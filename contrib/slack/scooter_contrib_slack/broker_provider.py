"""Slack provider module — static bot token, http-proxy only."""

from __future__ import annotations

from .config import SlackSettings
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.transports.mcp_tools import McpTools

from .mcp_tools import slack_mcp_server


UPSTREAM = "https://slack.com/api"


@register_provider
def slack() -> Provider:
    # Read at BUILD time, like every provider factory (#573).
    settings = SlackSettings()
    return Provider(
        name="slack",
        credential=StaticTokenSource(token=settings.slack_bot_token),
        transports=[
            HttpProxy(upstream=UPSTREAM, methods=("GET", "POST")),
            # The agent tools (slack_respond / slack_react / get_slack_context), moved
            # out of the agent-host by #700 so they ship with this contrib and are
            # ABSENT when it is not enabled. Same upstream as the proxy, from one
            # variable — a tool and the raw route must not drift.
            McpTools(server=slack_mcp_server(), upstream=UPSTREAM),
        ],
        enabled=bool(settings.slack_bot_token),
    )
