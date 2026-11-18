"""Databricks providers: one per configured workspace, as databricks-<name>.

The factories are generated at import from DATABRICKS_WORKSPACES, since the
registry keys a factory by its __name__. `databricks` itself (the entry point the
contrib's name requires) mounts the approvals and grants when access is gated, and
is otherwise disabled.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from scooter_broker_lib.approvals import Approvals, HostCards
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.forge import ForgeHost, ForgeHosts
from scooter_broker_lib.grants import Grants
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.file_token import FileTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Provider

from .config import DatabricksSettings
from .grants import DatabricksGrants, GrantPolicy, grant_approvals
from .store import GrantStore


@dataclass
class Gate:
    """The approvals and grants every workspace provider shares in one broker."""

    store: GrantStore
    approvals: Approvals
    owners: object


_GATES: dict[int, Gate] = {}


def gate(ctx: BrokerContext | None, s: DatabricksSettings) -> Gate | None:
    if ctx is None or s.databricks_grant_minutes <= 0:
        return None
    if id(ctx) not in _GATES:
        store = GrantStore(ctx.contrib_store_config("databricks"))
        approvals = grant_approvals(store, s.databricks_grant_minutes)
        approvals.configure(ctx.store_config, HostCards(s.agent_host_url) if s.agent_host_url else None)
        _GATES[id(ctx)] = Gate(store, approvals, ctx.owners)
    return _GATES[id(ctx)]


def workspace_provider(
    name: str, host_url: str, tokens_dir: str, agent_host_url: str = "", gated: Gate | None = None,
) -> Provider:
    host = urlsplit(host_url).hostname or ""
    return Provider(
        name=f"databricks-{name}",
        forge_policy=GrantPolicy(name, gated.store, gated.approvals, gated.owners) if gated else None,
        credential=FileTokenSource(Path(tokens_dir) / name),
        transports=[
            ForgeHosts(hosts=[ForgeHost(host, api_prefixes=("/api/",))]),
            HttpProxy(upstream=host_url, agent_host_url=agent_host_url),
        ] if host else [],
        enabled=bool(host),
    )


def _register(name: str) -> None:
    def factory(ctx: BrokerContext | None = None) -> Provider:
        s = DatabricksSettings()
        return workspace_provider(name, s.workspaces[name], s.databricks_tokens_dir, s.agent_host_url, gate(ctx, s))

    factory.__name__ = f"databricks_{name.replace('-', '_')}"
    register_provider(factory)


@register_provider
def databricks(ctx: BrokerContext | None = None) -> Provider:
    s = DatabricksSettings()
    g = gate(ctx, s) if s.workspaces else None
    transports = [g.approvals, Grants(contrib="databricks", source=DatabricksGrants(
        g.store, g.approvals, s.databricks_grant_minutes))] if g else []
    return Provider(name="databricks", credential=FileTokenSource(Path("/dev/null")), transports=transports,
                    enabled=g is not None)


for _name in DatabricksSettings().workspaces:
    _register(_name)
