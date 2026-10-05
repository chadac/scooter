"""DuckDuckGo broker provider — agent tools, no proxy route, and NO CREDENTIAL at all.

`enabled` gates on an explicit flag (`DUCKDUCKGO_ENABLED`) rather than on a key being
present like every other provider, because there is no key: nothing's absence could
mean "off", and the default must be off so that building this contrib does not make a
deployment start scraping DuckDuckGo. Why: PR #707.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from .config import DuckduckgoSettings
from .mcp_tools import UPSTREAM, duckduckgo_mcp_server

PROVIDER_NAME = "duckduckgo"


@register_provider
def duckduckgo() -> Provider:
    # Read at BUILD time, like every provider factory — the broker calls this once per
    # create_app(), after refreshing the environment.
    settings = DuckduckgoSettings()
    return Provider(
        name=PROVIDER_NAME,
        # credential=None by omission: `_Upstream` injects nothing without a credential
        # source, so the request goes out as written.
        transports=[McpTools(server=duckduckgo_mcp_server(), upstream=UPSTREAM)],
        # No raw /duckduckgo/* proxy: a second way to reach the page with none of the
        # parsing, which is the only thing that keeps a bot-check page from reading as
        # an empty web.
        enabled=settings.duckduckgo_enabled,
    )
