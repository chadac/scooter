"""Slack provider module — static bot token, http-proxy only."""

from __future__ import annotations

from .config import SlackSettings
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy


@register_provider
def slack() -> Provider:
    # Read at BUILD time, like every provider factory (#573).
    settings = SlackSettings()
    return Provider(
        name="slack",
        credential=StaticTokenSource(token=settings.slack_bot_token),
        transports=[
            HttpProxy(upstream="https://slack.com/api", methods=("GET", "POST")),
        ],
        enabled=bool(settings.slack_bot_token),
    )
