"""App factory: discover providers and mount every enabled one's transport routes under its prefix, with no per-provider code."""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack, asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, HTTPException

from .auth import authenticate, authenticate_mcp
from .authz import authorizer_from_settings
from .db_unavailable import install_db_unavailable_handler
from ..config import refresh_settings, settings
from scooter_broker_lib.autolink import Link, create_link, list_links
from scooter_broker_lib.commit_identity import resolve as resolve_commit_identity
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.owner import OwnerResolver, agent_host_fetcher
from scooter_broker_lib.user_secrets import KeyRing, SecretBox
from scooter_broker_lib.registry import discover_providers
from scooter_broker_lib.types import Identity
from scooter_lib.logging_config import configure_logging

logger = logging.getLogger(__name__)


async def _load_keyring() -> KeyRing:
    """The deployment keyring from its Secret, read on the first seal or open."""
    import asyncio

    from kubernetes import client, config

    from .user_secrets_key import load_or_create_keyring

    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
    return await asyncio.to_thread(load_or_create_keyring, client.CoreV1Api(), settings.sandbox_namespace)


def create_app() -> FastAPI:
    # Provider factories read `config.settings` at build time, so it must reflect the current environment.
    refresh_settings()

    # Passed in rather than hardcoded in the registry so the lib carries no import of this app.
    from .. import providers as builtin_providers

    # The substrate handed to any provider factory that declares a parameter.
    context = BrokerContext(
        authorizer=authorizer_from_settings(settings),
        store_config=settings.store_config(),
        owners=OwnerResolver(agent_host_fetcher(settings.agent_host_url)),
        user_secrets=SecretBox(_load_keyring),
    )
    providers = list(discover_providers([builtin_providers], context=context))

    # Sandbox provisioning lives in the agent-host (session/k8sProvisioner.ts), not here.

    # The agent-facing MCP server aggregates every enabled provider's tools behind one
    # endpoint with its own authentication, and is built before the lifespan that composes its own.
    mcp_app = None
    if settings.mcp_enabled:
        from ..mcp.routes import assert_tool_names_unique, create_mcp_app

        mcp_app = create_mcp_app(
            providers,
            authenticate=authenticate_mcp,
            agent_host_url=settings.agent_host_url,
        )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with AsyncExitStack() as stack:
            # Mounting an ASGI app does not run its lifespan, so the MCP app's is entered
            # here (first, so it is torn down last).
            if mcp_app is not None and mcp_app.lifespan is not None:
                await stack.enter_async_context(mcp_app.lifespan(app))
            if mcp_app is not None:
                # Awaited here because reading a server's tools is async and create_mcp_app is not.
                await assert_tool_names_unique(providers)
            for p in providers:
                if p.on_startup is not None:
                    await p.on_startup()
            from ..forge import start_forge_proxy

            forge_proxy = await start_forge_proxy(
                providers,
                port=settings.forge_proxy_port,
                namespace=settings.sandbox_namespace,
                agent_host_url=settings.agent_host_url,
            )
            yield
            if forge_proxy is not None:
                await forge_proxy.close()
            for p in providers:
                if p.on_shutdown is not None:
                    await p.on_shutdown()

    app = FastAPI(title="kubenix-agent-manager broker", lifespan=lifespan)
    install_db_unavailable_handler(app)

    # Deployment-default modules at GET /modules/default.tar.gz, unauthenticated since the
    # pod fetches them at boot and module Nix is not a secret.
    from .default_modules import create_default_modules_router

    app.include_router(create_default_modules_router())

    if mcp_app is not None:
        # Mounted rather than included so fastmcp's streaming stays intact.
        app.mount("/mcp", mcp_app)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    # Conversation links let an agent attach a link the auto-link injector missed and list
    # what is linked, always for the conversation its SA token names.
    @app.post("/link", status_code=201)
    async def attach_link(
        body: dict, identity: Identity = Depends(authenticate)
    ) -> dict[str, str]:
        url = (body.get("url") or "").strip()
        resource_type = (body.get("resourceType") or body.get("type") or "").strip()
        source = (body.get("source") or "").strip()
        if not url or not resource_type or not source:
            raise HTTPException(status_code=400, detail="source, resourceType, and url are required")
        link = Link(source=source, resource_type=resource_type, url=url, title=body.get("title"))
        try:
            await create_link(settings.agent_host_url, identity.conversation_id, link)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"agent-host link failed: {e}") from e
        except RuntimeError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        return {"status": "linked"}

    @app.get("/link")
    async def get_links(identity: Identity = Depends(authenticate)) -> dict[str, list]:
        try:
            links = await list_links(settings.agent_host_url, identity.conversation_id)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"agent-host list-links failed: {e}") from e
        return {"links": links}

    # Who this sandbox's commits are by; the sandbox polls it into its git config.
    @app.get("/git/identity")
    async def git_identity(identity: Identity = Depends(authenticate)) -> dict:
        acting = await context.owners.acting_user(identity) if context.owners else None
        return (await resolve_commit_identity(acting)).payload()

    for provider in providers:
        for transport in provider.transports:
            app.include_router(
                transport.routes(provider, authed=authenticate),
                prefix="" if provider.mount_at_root else f"/{provider.name}",
            )
        logger.info(
            "mounted provider",
            extra={
                "provider": provider.name,
                "transports": [t.name for t in provider.transports],
            },
        )

    return app


def main() -> None:
    import uvicorn

    # Installed before create_app() and uvicorn.run() so their lines share the root handler.
    configure_logging("broker")
    uvicorn.run(
        create_app(),
        host="0.0.0.0",
        port=settings.port,
        log_config=None,  # uvicorn's default dictConfig would replace the root handler
    )
