"""The k8s provider: the configured clusters, their approvals at /k8s/approvals and the agent tools.

Off unless `k8s_enabled`; the registry then drops the routes and tools.
"""

from __future__ import annotations

import logging

from scooter_broker_lib.approvals import HostCards
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from . import mcp_tools
from .auth import auth_for
from .config import parse_clusters, settings
from .kube import Kube
from .service import Cluster, K8sService
from .store import GrantStore

logger = logging.getLogger(__name__)


def clusters_from(raw: str) -> dict[str, Cluster]:
    """Each configured cluster that its auth can load; a broken one is logged and left out."""
    out = {}
    for name, cfg in parse_clusters(raw).items():
        try:
            out[name] = Cluster(config=cfg, kube=Kube(auth_for(cfg.auth), cfg.impersonate))
        except ValueError as e:
            logger.error("k8s cluster left out", extra={"cluster": name, "error": str(e)})
    return out


@register_provider
def k8s(ctx: BrokerContext) -> Provider:
    tools = McpTools(server=mcp_tools.mcp)
    if not settings.k8s_enabled:
        return Provider(name="k8s", transports=[K8sService({}, None, None).approvals, tools], enabled=False)

    service = K8sService(
        clusters_from(settings.k8s_clusters_json), GrantStore(ctx.contrib_store_config("k8s")), ctx.owners,
    )
    service.approvals.configure(ctx.store_config, HostCards(settings.agent_host_url) if settings.agent_host_url else None)
    mcp_tools.configure(service)
    return Provider(name="k8s", transports=[service.approvals, tools], enabled=True)
