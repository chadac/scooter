"""Provider registry — plugin discovery.

Modules self-register via @register_provider on import; external packages can
also contribute via the "agent_broker.providers" entry-point group. The core
discovers all registered providers at startup. Adding a provider never edits
the core.

Design stage: interfaces only.
"""

from __future__ import annotations

from typing import Callable

from .types import Provider

# A provider factory: builds a Provider (reads its own config/secrets).
ProviderFactory = Callable[[], Provider]


_REGISTRY: dict[str, ProviderFactory] = {}


def register_provider(factory: ProviderFactory) -> ProviderFactory:
    """Decorator: register a provider factory under its returned name.

    Usage:
        @register_provider
        def github() -> Provider: ...
    """
    ...


def discover_providers() -> list[Provider]:
    """Build all registered + entry-point providers, filtered to enabled ones.

    1. import the built-in providers package (triggers @register_provider)
    2. load "agent_broker.providers" entry-points (external modules)
    3. instantiate each factory, drop disabled ones
    """
    ...
