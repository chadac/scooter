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

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    providers = list(discover_providers())

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
            "mounted provider %s (transports: %s)",
            provider.name,
            ", ".join(t.name for t in provider.transports),
        )

    return app


def main() -> None:
    import uvicorn

    uvicorn.run(create_app(), host="0.0.0.0", port=settings.port)
