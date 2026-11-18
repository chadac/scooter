"""The k8s provider: the configured clusters, their approvals at /k8s/approvals and grants
at /k8s/grants, the agent tools and each cluster's forge-proxy host for kubectl and helm.

Off unless `k8s_enabled`; the registry then drops the routes and tools.
"""

from __future__ import annotations

import logging

import httpx

from scooter_broker_lib.approvals import HostCards
from scooter_broker_lib.grants import Grants
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.forge import ForgeHost, ForgeHosts
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from . import mcp_tools
from .auth import auth_for
from .config import ClusterConfig, parse_clusters, settings
from .forge import ClusterLink, KubeCredential, KubePolicy, KubeTransport, host_for, status_body
from .kube import Kube, KubeGateway
from .grants import K8sGrants
from .service import Cluster, K8sService
from .store import GrantStore

logger = logging.getLogger(__name__)


def clusters_from(raw: str) -> tuple[dict[str, ClusterConfig], dict[str, ClusterLink]]:
    """Each configured cluster that its auth can load, and its link; a broken one is logged and left out."""
    configs, links = {}, {}
    for name, cfg in parse_clusters(raw).items():
        try:
            auth = auth_for(cfg.auth)
        except ValueError as e:
            logger.error("k8s cluster left out", extra={"cluster": name, "error": str(e)})
            continue
        configs[name] = cfg
        links[name] = ClusterLink(auth)
    return configs, links


def forge_hosts(links: dict[str, ClusterLink]) -> ForgeHosts:
    return ForgeHosts(
        hosts=[
            ForgeHost(host_for(name), api_prefixes=("/",), client=httpx.AsyncClient(
                transport=KubeTransport(link), timeout=httpx.Timeout(30, read=600),
            ))
            for name, link in links.items()
        ],
        upgrade_refusal="exec, attach and port-forward don't go through the proxy; use the k8s_exec tool",
        # Only the broker may impersonate, and only for what the policy allowed.
        drop_header_prefixes=("impersonate-",),
        # kubectl prints a 403 reason only from a Status body.
        error_body=status_body,
    )


@register_provider
def k8s(ctx: BrokerContext) -> Provider:
    tools = McpTools(server=mcp_tools.mcp)
    if not settings.k8s_enabled:
        return Provider(name="k8s", transports=[K8sService({}, None, None).approvals, tools], enabled=False)

    configs, links = clusters_from(settings.k8s_clusters_json)
    grants = GrantStore(ctx.contrib_store_config("k8s"))
    policy = KubePolicy(configs, grants)
    gateway = KubeGateway(configs, links, policy)
    clusters = {name: Cluster(config=cfg, kube=Kube(gateway, name)) for name, cfg in configs.items()}
    service = K8sService(clusters, grants, ctx.owners)
    service.approvals.configure(ctx.store_config, HostCards(settings.agent_host_url) if settings.agent_host_url else None)
    mcp_tools.configure(service)
    listed = Grants(contrib="k8s", source=K8sGrants(grants, service.approvals, configs))
    return Provider(
        name="k8s", credential=KubeCredential(configs, links, policy),
        transports=[service.approvals, listed, tools, forge_hosts(links)], forge_policy=policy, enabled=True,
    )
