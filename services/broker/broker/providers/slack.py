"""Slack provider module — static bot token, http-proxy only."""

from __future__ import annotations

from ..core.registry import register_provider
from ..core.types import Provider
from ..sources.static_token import StaticTokenSource
from ..transports.http_proxy import HttpProxy


@register_provider
def slack() -> Provider:
    return Provider(
        name="slack",
        credential=StaticTokenSource(token=...),  # bot token, bearer
        transports=[
            HttpProxy(upstream="https://slack.com/api", methods=("GET", "POST")),
        ],
    )
