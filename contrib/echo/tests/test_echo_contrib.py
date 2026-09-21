"""Integration tests for the reference echo contrib.

These run in the contrib's Nix build with `broker` and `webhooks` present as
check inputs (they are absent from the package's runtime deps on purpose). They
prove the whole extension seam end-to-end: the entry-point metadata is declared,
the real registries discover the contrib THROUGH that entry point, and each half
builds a correctly shaped provider/handler that mounts a route.
"""

from __future__ import annotations

from importlib.metadata import entry_points

from scooter_contrib_echo import CONTRIB_NAME


def test_entrypoints_declared():
    """Both entry-point groups advertise the echo contrib (dist metadata)."""
    broker_eps = {ep.name: ep.value for ep in entry_points(group="agent_broker.providers")}
    webhook_eps = {ep.name: ep.value for ep in entry_points(group="scooter_webhooks.handlers")}
    assert broker_eps.get("echo") == "scooter_contrib_echo.broker_provider:echo_contrib"
    assert webhook_eps.get("echo") == "scooter_contrib_echo.webhooks_handler:echo_contrib"


def test_broker_discovers_echo_via_entrypoint():
    """The broker's real discovery loads the contrib through the entry point."""
    from scooter_broker_lib.registry import discover_providers

    providers = {p.name: p for p in discover_providers()}
    assert CONTRIB_NAME in providers
    echo = providers[CONTRIB_NAME]
    # The example transport mounts exactly one route: GET /echo/ping.
    router = echo.transports[0].routes(echo, authed=_noop_auth)
    paths = {r.path for r in router.routes}
    assert "/ping" in paths


def test_webhooks_discovers_echo_via_entrypoint():
    """The webhooks service's real discovery loads the contrib handler."""
    from scooter_webhooks_lib.registry import discover_webhooks

    handlers = {h.name: h for h in discover_webhooks()}
    assert CONTRIB_NAME in handlers
    paths = {r.path for r in handlers[CONTRIB_NAME].router.routes}
    assert "/webhooks/echo" in paths


async def _noop_auth():  # pragma: no cover - placeholder auth dependency
    from scooter_broker_lib.types import Identity

    return Identity(
        conversation_id="test",
        namespace="test",
        service_account="system:serviceaccount:test:sandbox-test",
    )
