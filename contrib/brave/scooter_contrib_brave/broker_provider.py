"""Brave broker provider — a key-bearing provider with TOOLS AND NO PROXY ROUTE.

Registered into the broker through the ``agent_broker.providers`` entry point. It
ships one transport, ``McpTools``, and deliberately no ``HttpProxy``: a raw
``/brave/*`` route would let the agent spend the search quota on arbitrary paths while
adding nothing a typed tool does not already do. (That is the case ``McpTools`` carries
its own ``upstream`` for, rather than reading it off a sibling proxy transport.)

``enabled`` is gated on the key being present, like every other keyed provider. With
no key the provider does not mount, so ``web_search`` is not in the agent's tool list
— which is the whole point of moving tools into contribs: a tool that cannot work is
absent rather than present-and-failing.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from .config import BraveSettings
from .mcp_tools import UPSTREAM, brave_mcp_server

PROVIDER_NAME = "brave"


@register_provider
def brave() -> Provider:
    # Read at BUILD time, like every provider factory — the broker calls this once per
    # create_app(), after refreshing the environment.
    settings = BraveSettings()
    key = (settings.brave_search_api_key or "").strip()
    return Provider(
        name=PROVIDER_NAME,
        # kind="header": Brave authenticates with X-Subscription-Token, and putting the
        # key in a header rather than the query string keeps it out of access logs.
        credential=StaticTokenSource(
            token=key, kind="header", header_name="X-Subscription-Token"
        ),
        transports=[McpTools(server=brave_mcp_server(), upstream=UPSTREAM)],
        enabled=bool(key),
    )
