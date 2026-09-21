"""Provider registry — plugin discovery.

Modules self-register via @register_provider on import; external packages can
also contribute via the "agent_broker.providers" entry-point group. The broker
app discovers all registered providers at startup. Adding a provider never edits
the app.

WHERE THE BUILT-INS COME FROM. This module used to hardcode `from .. import
providers`, which coupled the registry to the broker app package and is exactly
the dependency the lib split exists to remove. The built-in package(s) to scan
are now a PARAMETER: the app passes its own `broker.providers`, a test passes a
throwaway package, and a contrib needs neither. Entry-point loading stays here,
because it is the same mechanism for every caller.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from types import ModuleType
from typing import Callable, Iterable, Sequence

from .types import Provider

logger = logging.getLogger(__name__)

# The entry-point group external packages contribute providers through. Named
# here rather than at each call site so a contrib's pyproject and the loader can
# never disagree about the spelling.
ENTRY_POINT_GROUP = "agent_broker.providers"

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


def _import_builtin_providers(packages: Sequence[ModuleType]) -> None:
    """Import every module under each given package so their @register_provider
    decorators run."""
    for package in packages:
        for mod in pkgutil.iter_modules(package.__path__):
            importlib.import_module(f"{package.__name__}.{mod.name}")


def _load_entrypoint_providers() -> None:
    """Load providers contributed by external packages."""
    try:
        from importlib.metadata import entry_points
    except ImportError:  # pragma: no cover
        return
    for ep in entry_points(group=ENTRY_POINT_GROUP):
        try:
            ep.load()  # importing registers via @register_provider
        except Exception:  # pragma: no cover
            logger.exception(
                "failed loading provider entry-point",
                extra={"entry_point": ep.name},
            )


def discover_providers(
    builtin_packages: Iterable[ModuleType] = (),
) -> list[Provider]:
    """Build all registered + entry-point providers, keeping enabled ones.

    `builtin_packages`: packages whose modules are imported so their
    @register_provider decorators run — the broker app passes `broker.providers`.
    Entry-point providers are loaded regardless, so a caller with no in-tree
    providers passes nothing.

    Callers whose factories read a module-level settings object must refresh it
    BEFORE calling this; the registry cannot, since that object belongs to the
    app. See broker.core.app.
    """
    _import_builtin_providers(tuple(builtin_packages))
    _load_entrypoint_providers()
    providers: list[Provider] = []
    for name, factory in _REGISTRY.items():
        try:
            provider = factory()
        except Exception:
            # A provider whose factory raises is skipped so one bad provider can't
            # take down the whole broker — but it is then ABSENT (its routes
            # 404/503), which is easy to mistake for "disabled". Log it as a loud,
            # alert-worthy error naming the consequence, not a quiet "skip".
            logger.exception(
                "provider FAILED to build and is now ABSENT (its routes will not serve) "
                "— this is a misconfiguration/bug, not a deliberate disable",
                extra={"provider": name},
            )
            continue
        if provider.enabled:
            providers.append(provider)
    return providers
