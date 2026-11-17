"""Provider registry: plugin discovery.

Modules self-register via @register_provider on import, and external packages
contribute through the "agent_broker.providers" entry-point group. The packages to
scan for built-ins are a parameter of `discover_providers`, so a contrib needs none.
"""

from __future__ import annotations

import importlib
import inspect
import logging
import pkgutil
from types import ModuleType
from typing import TYPE_CHECKING, Callable, Iterable, Sequence, Union, overload

from .types import Provider

if TYPE_CHECKING:  # a runtime import would make sqlalchemy a registry dependency
    from .context import BrokerContext

logger = logging.getLogger(__name__)

# The entry-point group external packages contribute providers through.
ENTRY_POINT_GROUP = "agent_broker.providers"

# A provider factory, which may declare a BrokerContext parameter to receive the substrate it must not build itself.
ProviderFactory = Union[
    Callable[[], Provider],
    Callable[["BrokerContext"], Provider],
]


_REGISTRY: dict[str, ProviderFactory] = {}


@overload
def register_provider(factory: ProviderFactory, *, name: str | None = None) -> ProviderFactory: ...
@overload
def register_provider(*, name: str) -> Callable[[ProviderFactory], ProviderFactory]: ...
def register_provider(
    factory: ProviderFactory | None = None, *, name: str | None = None
) -> ProviderFactory | Callable[[ProviderFactory], ProviderFactory]:
    """Register a provider factory, keyed by `name` or else its __name__."""

    def register(f: ProviderFactory) -> ProviderFactory:
        # A bare duplicate still replaces (the broker's `echo` and the echo contrib's share a __name__); an explicit one is a mistake.
        if name is not None and name in _REGISTRY:
            raise ValueError(f"provider {name!r} is already registered")
        _REGISTRY[name or f.__name__] = f
        return f

    return register if factory is None else register(factory)


def _import_builtin_providers(packages: Sequence[ModuleType]) -> None:
    """Import every module under each package so their @register_provider decorators run."""
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


def wants_context(factory: ProviderFactory) -> bool:
    """Whether this factory asks for the BrokerContext by declaring a parameter."""
    return bool(inspect.signature(factory).parameters)


def discover_providers(
    builtin_packages: Iterable[ModuleType] = (),
    context: "BrokerContext | None" = None,
) -> list[Provider]:
    """Build every registered and entry-point provider and keep the enabled ones.

    `builtin_packages` are scanned so their @register_provider decorators run;
    `context` is passed only to factories that declare a parameter, and a factory
    that wants one when none was supplied raises rather than build without an
    enforcement point.
    """
    _import_builtin_providers(tuple(builtin_packages))
    _load_entrypoint_providers()
    providers: list[Provider] = []
    for name, factory in _REGISTRY.items():
        try:
            if wants_context(factory):
                if context is None:
                    raise RuntimeError(
                        f"provider {name!r} asks for a BrokerContext but the caller "
                        "supplied none — it would otherwise be built with no "
                        "authorizer and no database"
                    )
                provider = factory(context)
            else:
                provider = factory()
        except Exception:
            # A skipped provider is absent (its routes 404/503), which is easy to mistake for disabled, so the log names the consequence.
            logger.exception(
                "provider FAILED to build and is now ABSENT (its routes will not serve) "
                "— this is a misconfiguration/bug, not a deliberate disable",
                extra={"provider": name},
            )
            continue
        if provider.enabled:
            providers.append(provider)
    return providers
