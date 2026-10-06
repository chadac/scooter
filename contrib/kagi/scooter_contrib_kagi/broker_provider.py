"""Kagi broker provider — tools only, no proxy route (see contrib/brave for the why).

``enabled`` is gated on the key, so a deployment without one simply has no
``web_search``. Enabling this contrib AND brave is a startup failure, by design: both
own a tool of the same name, and a silent winner would make the agent's search quality
and its bill depend on mount order.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from .config import KagiSettings
from .mcp_tools import UPSTREAM, kagi_mcp_server

PROVIDER_NAME = "kagi"


@register_provider
def kagi() -> Provider:
    settings = KagiSettings()
    key = (settings.kagi_api_key or "").strip()
    return Provider(
        name=PROVIDER_NAME,
        # Kagi's scheme is `Authorization: Bot <token>` — a bearer-SHAPED header with a
        # different scheme word, so the prefix is part of the value rather than
        # kind="bearer" (which would send "Bearer <token>" and get a 401).
        credential=StaticTokenSource(
            token=f"Bot {key}" if key else "",
            kind="header",
            header_name="Authorization",
        ),
        transports=[McpTools(server=kagi_mcp_server(), upstream=UPSTREAM)],
        enabled=bool(key),
    )
