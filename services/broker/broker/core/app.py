"""App factory — assembles the broker from discovered provider modules.

The core is generic: discover providers, and for each enabled one, mount every
transport's routes under the provider's prefix. No per-provider code here.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, HTTPException

from .auth import authenticate
from .autolink import Link, create_link, list_links
from .registry import discover_providers
from .types import Identity
from ..config import settings
from ..logging_config import configure_logging

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    providers = list(discover_providers())

    # Sandbox lifecycle (the broker as control plane). Built when enabled; its size
    # store is init'd in the lifespan and its router mounted top-level (like /link).
    sandbox_store = None
    sandbox_router = None
    if settings.sandbox_lifecycle_enabled:
        from ..sandbox.config import deploy_config, size_store_config
        from ..sandbox.k8s import SandboxK8s
        from ..sandbox.routes import create_sandbox_router
        from ..sandbox.store import SandboxSizeStore

        sandbox_store = SandboxSizeStore(size_store_config(settings))
        sandbox_router = create_sandbox_router(SandboxK8s(deploy_config(settings)), sandbox_store)

    # Module registry (broker/registry/) — the shareable-module catalog. Built when
    # enabled; its store is init'd in the lifespan + its router mounted top-level.
    registry_store = None
    registry_router = None
    if settings.registry_enabled:
        from ..aws.store import StoreConfig
        from ..registry.routes import create_registry_router
        from ..registry.store import ModuleRegistryStore

        # Share the AWS DB components (same shared Postgres `broker` DB); the SQLite
        # registry_db_dsn is the dev default when no db_password is set.
        registry_store = ModuleRegistryStore(StoreConfig(
            dsn=settings.registry_db_dsn,
            db_host=settings.aws_db_host, db_port=settings.aws_db_port,
            db_user=settings.aws_db_user, db_password=settings.aws_db_password,
            db_name=settings.aws_db_name,
        ))
        registry_router = create_registry_router(registry_store)

    # Static shares (broker/shares/) — persistent static webpages served at /s/<uuid>/.
    # Built when enabled; its store is init'd in the lifespan + its router mounted
    # top-level (like /modules and /link).
    shares_store = None
    shares_router = None
    if settings.shares_enabled:
        from ..aws.store import StoreConfig
        from ..shares.routes import create_shares_router
        from ..shares.store import ShareStore

        shares_store = ShareStore(StoreConfig(
            dsn=settings.shares_db_dsn,
            db_host=settings.aws_db_host, db_port=settings.aws_db_port,
            db_user=settings.aws_db_user, db_password=settings.aws_db_password,
            db_name=settings.aws_db_name,
        ))
        shares_router = create_shares_router(
            shares_store, public_base_url=settings.shares_public_base_url
        )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Run providers' async startup hooks (e.g. open a DB, start a sweep).
        for p in providers:
            if p.on_startup is not None:
                await p.on_startup()
        yield
        for p in providers:
            if p.on_shutdown is not None:
                await p.on_shutdown()

    app = FastAPI(title="kubenix-agent-manager broker", lifespan=lifespan)

    if sandbox_router is not None:
        app.include_router(sandbox_router)

    if registry_router is not None:
        app.include_router(registry_router)

    if shares_router is not None:
        app.include_router(shares_router)

    # Deployment-default modules — GET /modules/default.tar.gz, UNAUTHENTICATED (the
    # pod fetches at boot; module Nix isn't a secret). Always mounted; serves an empty
    # tarball when no default-modules dir is configured.
    from .default_modules import create_default_modules_router

    app.include_router(create_default_modules_router())

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    # Conversation links — the agent-facing complement to the auto-link injector.
    # The injector auto-links PRs/MRs/issues created THROUGH the proxy; this lets an
    # agent explicitly attach a link the injector missed (e.g. created via the gh/glab
    # CLI, or a resource type not watched) and list what's currently linked. The
    # conversation is taken from the caller's SA token — never a request field — so an
    # agent can only touch its OWN conversation's links. The sandbox reaches these via
    # `agent-broker link ...` (see the scooter-links skill).
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

    for provider in providers:
        for transport in provider.transports:
            app.include_router(
                transport.routes(provider, authed=authenticate),
                prefix=f"/{provider.name}",
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

    # Structured JSON logs (one object per line) — replaces logging.basicConfig.
    # Installed BEFORE create_app() so provider discovery's own lines are captured
    # in the same shape, and before uvicorn.run() so uvicorn's loggers inherit the
    # root handler instead of installing their own prose formatter.
    configure_logging("broker")
    uvicorn.run(
        create_app(),
        host="0.0.0.0",
        port=settings.port,
        log_config=None,  # keep OUR root handler; uvicorn's default dictConfig replaces it
    )
