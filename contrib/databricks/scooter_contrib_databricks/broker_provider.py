"""Databricks providers: one per configured workspace, as databricks-<name>.

The factories are generated at import from DATABRICKS_WORKSPACES, since the
registry keys a factory by its __name__. `databricks` itself (the entry point the
contrib's name requires) is an always-disabled placeholder.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

from scooter_broker_lib.forge import ForgeHost, ForgeHosts
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.file_token import FileTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Provider

from .config import DatabricksSettings


def workspace_provider(name: str, host_url: str, tokens_dir: str, agent_host_url: str = "") -> Provider:
    host = urlsplit(host_url).hostname or ""
    return Provider(
        name=f"databricks-{name}",
        credential=FileTokenSource(Path(tokens_dir) / name),
        transports=[
            ForgeHosts(hosts=[ForgeHost(host, api_prefixes=("/api/",))]),
            HttpProxy(upstream=host_url, agent_host_url=agent_host_url),
        ] if host else [],
        enabled=bool(host),
    )


def _register(name: str) -> None:
    def factory() -> Provider:
        s = DatabricksSettings()
        return workspace_provider(name, s.workspaces[name], s.databricks_tokens_dir, s.agent_host_url)

    factory.__name__ = f"databricks_{name.replace('-', '_')}"
    register_provider(factory)


@register_provider
def databricks() -> Provider:
    return Provider(name="databricks", credential=FileTokenSource(Path("/dev/null")), transports=[], enabled=False)


for _name in DatabricksSettings().workspaces:
    _register(_name)
