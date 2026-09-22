"""The gitlab handler, exercised through the real extension seam.

These moved out of the webhooks app's suite with the handler (PR #580). The app
no longer knows gitlab exists, so what proves the integration is the entry point
plus the registries: discovery finds the handler, its route mounts, its gating
answers, and its owner lookup and resource shapes arm when it is imported.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_contrib_gitlab import CONTRIB_NAME
from scooter_contrib_gitlab import webhooks_handler as gitlab_h


@pytest.fixture
def client():
    """A minimal app with only this contrib's router mounted — no webhooks app."""
    app = FastAPI()
    app.include_router(gitlab_h.router)
    return TestClient(app)


def test_entrypoints_declared():
    from importlib.metadata import entry_points

    broker_eps = {ep.name: ep.value for ep in entry_points(group="agent_broker.providers")}
    webhook_eps = {ep.name: ep.value for ep in entry_points(group="scooter_webhooks.handlers")}
    assert broker_eps.get("gitlab") == "scooter_contrib_gitlab.broker_provider:gitlab"
    assert webhook_eps.get("gitlab") == "scooter_contrib_gitlab.webhooks_handler:gitlab"


def test_webhooks_discovers_gitlab_via_entrypoint():
    from scooter_webhooks_lib.registry import discover_webhooks

    handlers = {h.name: h for h in discover_webhooks()}
    assert CONTRIB_NAME in handlers
    paths = {r.path for r in handlers[CONTRIB_NAME].router.routes}
    assert "/webhooks/gitlab" in paths


def test_gitlab_webhook_disabled(client):
    """Off toggle answers `disabled` in-route rather than unmounting."""
    with patch.object(gitlab_h, "settings") as mock_settings:
        mock_settings.gitlab_enabled = False
        resp = client.post(
            "/webhooks/gitlab",
            headers={"X-Gitlab-Event": "Note Hook", "X-Gitlab-Token": ""},
            json={},
        )
        assert resp.json()["status"] == "disabled"


def test_gitlab_webhook_invalid_token(client):
    with patch.object(gitlab_h, "settings") as mock_settings:
        mock_settings.gitlab_enabled = True
        mock_settings.gitlab_webhook_secret = "real-secret"
        resp = client.post(
            "/webhooks/gitlab",
            headers={"X-Gitlab-Event": "Note Hook", "X-Gitlab-Token": "wrong"},
            json={},
        )
        assert resp.status_code == 401


def test_importing_the_handler_arms_the_owner_lookup_and_shapes():
    """The registration hazard, contrib-side.

    identity/resources register by import side effect and nothing else imports
    them, so losing either line from webhooks_handler.py would silently stop owner
    resolution and make a URL-form link stop matching the short form (issue #563).
    """
    from scooter_webhooks_lib import identity, resources

    assert "gitlab" in identity.registered_providers()
    assert "gitlab" in resources.registered_sources()
