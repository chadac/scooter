"""Provider registry — plugin discovery.

Modules self-register via @register_provider on import; external packages can
also contribute via the "agent_broker.providers" entry-point group. The core
discovers all registered providers at startup. Adding a provider never edits
the core.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from typing import Callable

from .types import Provider

logger = logging.getLogger(__name__)

# A provider factory: builds a Provider (reads its own config/secrets).
ProviderFactory = Callable[[], Provider]


_REGISTRY: dict[str, ProviderFactory] = {}


def register_provider(factory: ProviderFactory) -> ProviderFactory:
    """Decorator: register a provider factory.

    Keyed by the factory's __name__ (the provider's module name); the built
    Provider carries its own `name` for routing.
    """
    _REGISTRY[factory.__name__] = factory
    return factory


def _import_builtin_providers() -> None:
    """Import every module under broker.providers so their @register_provider
    decorators run."""
    from .. import providers

    for mod in pkgutil.iter_modules(providers.__path__):
        importlib.import_module(f"{providers.__name__}.{mod.name}")


def _load_entrypoint_providers() -> None:
    """Load providers contributed by external packages."""
    try:
        from importlib.metadata import entry_points
    except ImportError:  # pragma: no cover
        return
    for ep in entry_points(group="agent_broker.providers"):
        try:
            ep.load()  # importing registers via @register_provider
        except Exception:  # pragma: no cover
            logger.exception("failed loading provider entry-point %s", ep.name)


def discover_providers() -> list[Provider]:
    """Build all registered + entry-point providers, keeping enabled ones."""
    # Re-read env into the shared settings so provider factories (which read
    # `config.settings` at build time) reflect the CURRENT environment — not a
    # snapshot frozen at first import. This makes create_app() deterministic
    # regardless of test import order (the test-provider-enabled flag, etc.).
    from ..config import refresh_settings

    refresh_settings()
    _import_builtin_providers()
    _load_entrypoint_providers()
    providers: list[Provider] = []
    for name, factory in _REGISTRY.items():
        try:
            provider = factory()
        except Exception:
            # Finding #21: a provider whose factory raises is skipped so one bad
            # provider can't take down the whole broker — but it's then ABSENT (its
            # routes 404/503), which is easy to mistake for "disabled". Log it as a
            # loud, alert-worthy error naming the consequence, not a quiet "skip".
            logger.exception(
                "provider %s FAILED to build and is now ABSENT (its routes will not "
                "serve) — this is a misconfiguration/bug, not a deliberate disable",
                name,
            )
            continue
        if provider.enabled:
            providers.append(provider)
    return providers
