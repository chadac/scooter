"""Webhook handler registry — plugin discovery.

Mirrors the broker's provider registry (`broker/core/registry.py`). Handler
modules self-register via @register_webhook on import; external packages can
also contribute via the "scooter_webhooks.handlers" entry-point group. The app
discovers all registered handlers at startup and mounts each one's router.
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
from typing import Callable

from fastapi import APIRouter

logger = logging.getLogger(__name__)


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


def _import_builtin_handlers() -> None:
    """Import every module under webhooks.handlers so their @register_webhook
    decorators run."""
    from . import handlers

    for mod in pkgutil.iter_modules(handlers.__path__):
        importlib.import_module(f"{handlers.__name__}.{mod.name}")


def _load_entrypoint_handlers() -> None:
    """Load handlers contributed by external packages."""
    try:
        from importlib.metadata import entry_points
    except ImportError:  # pragma: no cover
        return
    for ep in entry_points(group="scooter_webhooks.handlers"):
        try:
            ep.load()  # importing registers via @register_webhook
        except Exception:  # pragma: no cover
            logger.exception(
                "failed loading webhook handler entry-point",
                extra={"entry_point": ep.name},
            )


def discover_webhooks() -> list[WebhookHandler]:
    """Build all registered + entry-point handlers, keeping enabled ones."""
    _import_builtin_handlers()
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
