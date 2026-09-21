"""Tests for the webhook handler registry (plugin discovery).

Mirrors the broker's provider-registry contract: handler modules self-register
via @register_webhook and app.py mounts whatever is discovered — no hardcoded
per-provider wiring.
"""

from fastapi import APIRouter

from webhooks.registry import (
    WebhookHandler,
    discover_webhooks,
    register_webhook,
)


BUILTIN_HANDLERS = {"github", "gitlab", "jira", "slack", "test"}


def test_discovers_all_builtin_handlers():
    """Every built-in handler module self-registers and is discovered."""
    names = {h.name for h in discover_webhooks()}
    assert BUILTIN_HANDLERS <= names


def test_every_discovered_handler_has_a_router():
    for h in discover_webhooks():
        assert isinstance(h, WebhookHandler)
        assert isinstance(h.router, APIRouter)


def test_app_mounts_discovered_routes():
    """The app wires each discovered router — the provider POST endpoints exist.

    Uses the OpenAPI path map rather than introspecting Starlette route objects,
    which is stable across FastAPI versions (dev venv vs. the flake-pinned one)
    and doesn't execute any handler.
    """
    from webhooks.app import app

    paths = set(app.openapi()["paths"].keys())
    for expected in (
        "/webhooks/github",
        "/webhooks/gitlab",
        "/webhooks/jira",
        "/webhooks/slack",
        "/webhooks/test",
    ):
        assert expected in paths


def test_disabled_handler_is_omitted_from_discovery():
    """A handler whose factory reports enabled=False is not returned (the parity
    knob for third-party handlers that prefer mount-time gating over in-route
    gating)."""

    @register_webhook
    def _disabled_probe() -> WebhookHandler:  # noqa: D401
        return WebhookHandler(name="_disabled_probe", router=APIRouter(), enabled=False)

    names = {h.name for h in discover_webhooks()}
    assert "_disabled_probe" not in names


def test_failing_factory_is_skipped_not_fatal():
    """One handler whose factory raises must not take down discovery of the rest."""

    @register_webhook
    def _boom() -> WebhookHandler:
        raise RuntimeError("factory blew up")

    names = {h.name for h in discover_webhooks()}
    assert BUILTIN_HANDLERS <= names  # the good ones still come through
    assert "_boom" not in names
