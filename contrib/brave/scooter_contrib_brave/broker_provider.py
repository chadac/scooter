"""Brave Search provider module — API key via X-Subscription-Token, http-proxy only.

Proxies /brave/* -> api.search.brave.com with the subscription token injected, so
the agent can run web searches without ever seeing the key. Enabled iff the key
is configured.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy

from .config import BraveSearchSettings


@register_provider
def brave() -> Provider:
    # Read at BUILD time, like every provider factory — the broker calls this
    # once per create_app(), after refreshing the environment.
    settings = BraveSearchSettings()
    api_key = (settings.brave_search_api_key or "").strip()
    return Provider(
        # Short on purpose: this is the broker path prefix the agent types
        # (/brave/res/v1/web/search?q=...).
        name="brave",
        # Brave ignores `Authorization: Bearer …` and reads its own header, so
        # kind="header" rather than the default bearer.
        credential=StaticTokenSource(
            token=api_key, kind="header", header_name="X-Subscription-Token"
        ),
        # BARE host upstream: a transparent proxy, so agents use Brave's own API
        # paths (/brave/res/v1/web/search -> api.search.brave.com/res/v1/...).
        transports=[HttpProxy(upstream="https://api.search.brave.com")],
        # No key means the /brave/* routes must not mount at all — a
        # half-configured provider would proxy unauthenticated and 401 every call.
        enabled=bool(api_key),
    )
