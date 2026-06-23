"""App factory — assembles the broker from discovered provider modules.

The core is generic: discover providers, and for each enabled one, mount every
transport's routes under the provider's prefix. No per-provider code here.

Design stage: structure only.
"""

from __future__ import annotations

from fastapi import FastAPI

from .auth import authenticate
from .registry import discover_providers


def create_app() -> FastAPI:
    """Build the broker FastAPI app.

    for provider in discover_providers():
        for transport in provider.transports:
            app.include_router(
                transport.routes(provider, authed=authenticate),
                prefix=f"/{provider.name}",
            )
    + GET /health
    """
    ...


def main() -> None:
    """uvicorn entry point (broker on its configured port)."""
    ...
