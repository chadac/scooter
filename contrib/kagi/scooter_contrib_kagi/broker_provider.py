"""Kagi provider module — API key via `Authorization: Bot …`, http-proxy only.

Proxies /kagi/* -> kagi.com with the key injected, so the agent can use Kagi's
search/enrichment APIs without ever seeing it. Enabled iff the key is configured.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy

from .config import KagiSettings


@register_provider
def kagi() -> Provider:
    # Read at BUILD time, like every provider factory — the broker calls this
    # once per create_app(), after refreshing the environment.
    settings = KagiSettings()
    api_key = (settings.kagi_api_key or "").strip()
    return Provider(
        # Short on purpose: this is the broker path prefix the agent types
        # (/kagi/api/v0/search?q=...).
        name="kagi",
        # Kagi's scheme is `Bot`, not `Bearer`, so kind="bearer" cannot express
        # it. kind="header" sets the value VERBATIM, which is why the prefix
        # lives inside the token string rather than in a separate option — a
        # scheme option would exist for this one provider and nothing else.
        credential=StaticTokenSource(
            token=f"Bot {api_key}" if api_key else "",
            kind="header",
            header_name="Authorization",
        ),
        # BARE host upstream: a transparent proxy, so agents use Kagi's own API
        # paths (/kagi/api/v0/search -> kagi.com/api/v0/search).
        transports=[HttpProxy(upstream="https://kagi.com")],
        # Gate on the RAW key: the token is always non-empty once prefixed, so
        # bool(token) would mount the routes for an unconfigured provider.
        enabled=bool(api_key),
    )
