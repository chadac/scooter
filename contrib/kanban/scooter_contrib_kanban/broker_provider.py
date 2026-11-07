"""The kanban provider: the card store, its routes and the agent tools.

Off unless `kanban_enabled`; the registry then drops the routes and tools, so no
agent is offered a board that is not there.
"""

from __future__ import annotations

from datetime import timedelta

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from . import mcp_tools
from .config import parse_columns, settings
from .store import KanbanStore
from .transport import Kanban


@register_provider
def kanban(ctx: BrokerContext) -> Provider:
    columns = parse_columns(settings.kanban_columns)
    stale_after = timedelta(seconds=settings.kanban_stale_after_seconds)
    transport = Kanban(columns=columns, stale_after=stale_after)
    tools = McpTools(server=mcp_tools.kanban_mcp_server())

    if not settings.kanban_enabled:
        return Provider(name="kanban", transports=[transport, tools], enabled=False)

    store = KanbanStore(ctx.contrib_store_config("kanban"))
    transport.store = store
    mcp_tools.configure(store, columns, stale_after)
    return Provider(name="kanban", transports=[transport, tools], enabled=True)
