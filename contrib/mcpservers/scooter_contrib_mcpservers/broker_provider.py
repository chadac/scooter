"""The mcpservers provider: the server-list store and its routes."""

from __future__ import annotations

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider

from .config import McpServersSettings
from .store import McpServerStore
from .transport import McpServers


@register_provider
def mcpservers(ctx: BrokerContext) -> Provider:
    transport = McpServers()
    if not McpServersSettings().mcpservers_enabled or ctx.owners is None:
        return Provider(name="mcpservers", transports=[transport], enabled=False)
    transport.store = McpServerStore(ctx.contrib_store_config("mcpservers"))
    transport.owners = ctx.owners
    return Provider(name="mcpservers", transports=[transport], enabled=True)
