"""The handoff provider: the search index, spawn approvals, their routes and the agent tools.

Off unless `handoff_enabled`; the registry then drops the routes and tools, so no agent
is offered a handoff that is not there.
"""

from __future__ import annotations

from scooter_broker_lib.approvals import HostCards
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from . import mcp_tools
from .agent_host import AgentHost
from .approvals import spawn_approvals
from .config import settings
from .spawn import Spawner
from .store import HandoffStore
from .transport import Handoff


@register_provider
def handoff(ctx: BrokerContext) -> Provider:
    transport = Handoff()
    tools = McpTools(server=mcp_tools.mcp)

    if not settings.handoff_enabled:
        return Provider(name="handoff", transports=[transport, spawn_approvals(None), tools], enabled=False)

    store = HandoffStore(ctx.contrib_store_config("handoff"))
    agent_host = AgentHost(settings.agent_host_url) if settings.agent_host_url else None
    transport.store, transport.agent_host = store, agent_host
    spawner = Spawner(agent_host, settings.handoff_public_base_url, ctx.owners) if agent_host else None
    spawns = spawn_approvals(spawner)
    spawns.configure(ctx.store_config, HostCards(settings.agent_host_url) if agent_host else None)
    mcp_tools.configure(
        store, agent_host, settings.handoff_public_base_url,
        owners=ctx.owners, spawns=spawns, require_approval=settings.handoff_require_approval,
    )
    return Provider(name="handoff", transports=[transport, spawns, tools], enabled=True)
