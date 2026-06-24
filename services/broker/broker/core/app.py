"""App factory — assembles the broker from discovered provider modules.

The core is generic: discover providers, and for each enabled one, mount every
transport's routes under the provider's prefix. No per-provider code here.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .auth import authenticate
from .registry import discover_providers
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
