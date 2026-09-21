"""Webhook handler registry — plugin discovery.

Mirrors the broker's provider registry (`scooter_broker_lib/registry.py`), down
to the built-in scan being a PARAMETER rather than a hardcoded `from . import
handlers`: that import is what would tie this module to the webhooks app and
keep it out of the lib. The app passes its own `webhooks.handlers`; a contrib
passes nothing and is found through the entry-point group.

Handler modules self-register via @register_webhook on import; external packages
can also contribute via the "scooter_webhooks.handlers" entry-point group. The
app discovers all registered handlers at startup and mounts each one's router.
Adding a handler never edits `app.py`.

Unlike the broker — whose providers are filtered out entirely when disabled —
webhook handlers self-gate *in-route* (a disabled provider returns
`{"status": "disabled"}`, not a 404), so the built-in handlers register with
`enabled=True` and keep their existing per-request gating. The `enabled` flag
exists for parity and for third-party handlers that prefer mount-time gating.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from dataclasses import dataclass
from types import ModuleType
from typing import Callable, Iterable, Sequence

from fastapi import APIRouter

logger = logging.getLogger(__name__)

# The entry-point group external packages contribute handlers through. Named here
# rather than at the call site so a contrib's pyproject and the loader can never
# disagree about the spelling.
ENTRY_POINT_GROUP = "scooter_webhooks.handlers"


@dataclass
class WebhookHandler:
    """One discovered handler = a name + the router it mounts."""

    name: str
    router: APIRouter
    enabled: bool = True


# A handler factory: builds a WebhookHandler (reads its own config).
WebhookFactory = Callable[[], WebhookHandler]

_REGISTRY: dict[str, WebhookFactory] = {}


def register_webhook(factory: WebhookFactory) -> WebhookFactory:
    """Decorator: register a handler factory, keyed by the factory's __name__
    (the handler's module name). The built WebhookHandler carries its own
    `name`."""
    _REGISTRY[factory.__name__] = factory
    return factory


def _import_builtin_handlers(packages: Sequence[ModuleType]) -> None:
    """Import every module under each given package so their @register_webhook
    decorators run."""
    for package in packages:
        for mod in pkgutil.iter_modules(package.__path__):
            importlib.import_module(f"{package.__name__}.{mod.name}")


def _load_entrypoint_handlers() -> None:
    """Load handlers contributed by external packages."""
    try:
        from importlib.metadata import entry_points
    except ImportError:  # pragma: no cover
        return
    for ep in entry_points(group=ENTRY_POINT_GROUP):
        try:
            ep.load()  # importing registers via @register_webhook
        except Exception:  # pragma: no cover
            logger.exception(
                "failed loading webhook handler entry-point",
                extra={"entry_point": ep.name},
            )


def discover_webhooks(
    builtin_packages: Iterable[ModuleType] = (),
) -> list[WebhookHandler]:
    """Build all registered + entry-point handlers, keeping enabled ones.

    `builtin_packages`: packages whose modules are imported so their
    @register_webhook decorators run — the webhooks app passes
    `webhooks.handlers`. Entry-point handlers are loaded regardless, so a caller
    with no in-tree handlers passes nothing.
    """
    _import_builtin_handlers(tuple(builtin_packages))
    _load_entrypoint_handlers()
    handlers: list[WebhookHandler] = []
    for name, factory in _REGISTRY.items():
        try:
            handler = factory()
        except Exception:
            # A handler whose factory raises is skipped so one bad handler can't
            # take down the whole service — but it's then ABSENT (its routes
            # 404), which is easy to mistake for "disabled". Log it loudly.
            logger.exception(
                "webhook handler FAILED to build and is now ABSENT (its routes "
                "will not serve) — this is a misconfiguration/bug, not a "
                "deliberate disable",
                extra={"handler": name},
            )
            continue
        if handler.enabled:
            handlers.append(handler)
    return handlers
