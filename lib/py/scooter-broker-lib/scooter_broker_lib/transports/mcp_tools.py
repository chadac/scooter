"""mcp-tools transport — a provider's AGENT TOOLS, served by the broker's /mcp.

Mounts no routes. A transport is "a delivery mechanism for a credential", and an MCP
tool is one: the agent calls the tool, the broker injects the credential upstream, and
the agent never holds the secret — the same property `HttpProxy` has, with a typed
surface instead of a raw path.

WHY IT IS A TRANSPORT AND NOT A NEW FIELD ON `Provider`. The core's rule stays one
sentence (mount every transport's routes, mount every transport's MCP server), so a
provider that wants tools and nothing else composes `McpTools(...)` exactly as it
would compose `HttpProxy(...)`, and `HttpProxy` itself could grow tools later without a
second concept. `routes()` returning an empty router is the honest answer to "what do
you mount" rather than a special case in the core.

See scooter_broker_lib/mcp.py for what a tool is handed, and issue #700 for why tools
moved out of the agent-host.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from fastapi import APIRouter

from ..types import AuthDependency, Provider, Transport

if TYPE_CHECKING:
    from fastmcp import FastMCP


def _empty_server() -> "FastMCP":
    from fastmcp import FastMCP

    return FastMCP(name="empty")


@dataclass
class McpTools(Transport):
    """Carry a provider's agent tools as a `FastMCP` server.

    The provider's factory builds the server with `@mcp.tool` decorators; the broker
    mounts it NAMESPACE-LESS so tool names stay flat.
    """

    server: "FastMCP" = field(default_factory=_empty_server)
    # The API base a tool's `ctx.upstream` calls, e.g. "https://api.github.com".
    # Declared here rather than read off a sibling HttpProxy: a provider may ship
    # tools WITHOUT a proxy route (a search provider has no reason to expose a raw
    # proxy), and a factory that ships both passes the same local variable to each —
    # `HttpProxy(upstream=url)` and `McpTools(server=…, upstream=url)` — which is how
    # every shipped provider already reads.
    upstream: str = ""
    name: str = "mcp-tools"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        """Nothing to mount. The tools are served by the broker's single /mcp
        endpoint, which authenticates differently (an SA token AND a conversation
        token) from the per-provider routes."""
        return APIRouter()

    @property
    def mcp_server(self) -> "FastMCP":
        """The server the broker mounts. Discovered by `hasattr`, which is what lets
        the four shipped transports that have no tools stay untouched."""
        return self.server
