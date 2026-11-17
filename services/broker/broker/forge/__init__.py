"""The forge egress proxy: git, gh and glab reach the forges through the broker, which holds the token."""

from __future__ import annotations

import asyncio
import logging

from fastapi import HTTPException

from scooter_broker_lib.types import Identity, Provider

from .proxy import ForgeProxy, ProxyAuthError, Route, build_routes

logger = logging.getLogger(__name__)

__all__ = ["ForgeProxy", "ProxyAuthError", "Route", "build_routes", "start_forge_proxy"]


async def _authenticate(token: str) -> Identity:
    from ..core.auth import sandbox_identity

    try:
        return await sandbox_identity(token)
    except HTTPException as e:
        # A 401 from TokenReview is the proxy's 407; anything else stays as it is.
        raise ProxyAuthError(407 if e.status_code == 401 else e.status_code, str(e.detail)) from e


async def start_forge_proxy(providers: list[Provider], *, port: int, namespace: str, agent_host_url: str) -> ForgeProxy | None:
    """Load (or create) the CA for every enabled provider's forge hosts and start listening; None when no provider declares one."""
    from kubernetes import client, config

    from .ca import LeafIssuer
    from .ca_store import load_or_create_cas

    routes = build_routes([p for p in providers if p.enabled])
    if not routes:
        logger.info("forge proxy not started: no enabled provider declares forge hosts")
        return None
    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
    cas = await asyncio.to_thread(load_or_create_cas, client.CoreV1Api(), namespace, sorted(routes))
    proxy = ForgeProxy(routes, LeafIssuer(*cas), _authenticate, agent_host_url=agent_host_url)
    await proxy.start("0.0.0.0", port)
    return proxy
