"""Slack provider: a static bot token over http-proxy and the agent tools."""

from __future__ import annotations

from .config import SlackSettings
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.transports.mcp_tools import McpTools

from .awaiting_input import AwaitingInputNotice
from .mcp_tools import slack_mcp_server


UPSTREAM = "https://slack.com/api"


@register_provider
def slack() -> Provider:
    # Read at build time, like every provider factory.
    settings = SlackSettings()
    return Provider(
        name="slack",
        credential=StaticTokenSource(token=settings.slack_bot_token),
        transports=[
            HttpProxy(upstream=UPSTREAM, methods=("GET", "POST")),
            # The agent tools share the proxy's upstream so the two cannot drift.
            McpTools(server=slack_mcp_server(), upstream=UPSTREAM),
            AwaitingInputNotice(upstream=UPSTREAM),
        ],
        enabled=bool(settings.slack_bot_token),
    )
