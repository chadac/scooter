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
from .boards import Boards
from .config import parse_stages, settings
from .folders import RouterFolders
from .keys import CardKeys
from .store import KanbanStore
from .transport import Kanban


@register_provider
def kanban(ctx: BrokerContext) -> Provider:
    stale_after = timedelta(seconds=settings.kanban_stale_after_seconds)
    transport = Kanban(stale_after=stale_after)
    tools = McpTools(server=mcp_tools.kanban_mcp_server())

    if not settings.kanban_enabled:
        return Provider(name="kanban", transports=[transport, tools], enabled=False)

    boards = Boards(
        store=KanbanStore(ctx.contrib_store_config("kanban")),
        folders=RouterFolders(),
        default_stages=parse_stages(settings.kanban_stages),
    )
    transport.boards = boards
    keys = CardKeys(settings.agent_host_url) if settings.agent_host_url else None
    mcp_tools.configure(boards, stale_after, keys)
    return Provider(name="kanban", transports=[transport, tools], enabled=True)
