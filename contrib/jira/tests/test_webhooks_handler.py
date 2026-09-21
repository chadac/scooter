"""The jira handler, exercised through the real extension seam.

Moved out of the webhooks app's suite with the handler (PR #582). The app no
longer knows jira exists, so what proves the integration is the entry point plus
the registries: discovery finds the handler, its route mounts, its gating answers,
and its resource shapes arm when it is imported.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_contrib_jira import CONTRIB_NAME
from scooter_contrib_jira import webhooks_handler as jira_h


@pytest.fixture
def client():
    """A minimal app with only this contrib's router mounted — no webhooks app."""
    app = FastAPI()
    app.include_router(jira_h.router)
    return TestClient(app)


def test_entrypoints_declared():
    from importlib.metadata import entry_points

    broker_eps = {ep.name: ep.value for ep in entry_points(group="agent_broker.providers")}
    webhook_eps = {ep.name: ep.value for ep in entry_points(group="scooter_webhooks.handlers")}
    assert broker_eps.get("jira") == "scooter_contrib_jira.broker_provider:jira"
    assert webhook_eps.get("jira") == "scooter_contrib_jira.webhooks_handler:jira"


def test_webhooks_discovers_jira_via_entrypoint():
    from scooter_webhooks_lib.registry import discover_webhooks

    handlers = {h.name: h for h in discover_webhooks()}
    assert CONTRIB_NAME in handlers
    paths = {r.path for r in handlers[CONTRIB_NAME].router.routes}
    assert "/webhooks/jira" in paths


def test_jira_webhook_disabled(client):
    """Off toggle answers `disabled` in-route rather than unmounting."""
    with patch.object(jira_h, "settings") as mock_settings:
        mock_settings.jira_enabled = False
        resp = client.post("/webhooks/jira", json={})
        assert resp.json()["status"] == "disabled"


def test_importing_the_handler_arms_the_resource_shapes():
    """Shapes register by import side effect and nothing else imports them: losing
    that line would make a browse-URL link stop matching a bare key (issue #563)."""
    from scooter_webhooks_lib import resources

    assert "jira" in resources.registered_sources()


async def test_jira_ack_posts_before_the_run():
    """The 'Scooter is on it' ack must post BEFORE the agent run.

    create_conversation() blocks until the whole turn finishes, so posting the ack
    after it returned delayed the link by the entire run. The handler posts inside
    the `on_created` hook; a fake create_conversation fires it and records ORDER.
    """
    order: list[str] = []

    async def rec_post(*a, **k):
        order.append("ack")

    async def fake_create(*args, on_created=None, **kwargs):
        if on_created is not None:
            await on_created("conv-xyz")
        order.append("run")
        return {"conversation_id": "conv-xyz", "result": "done"}

    # AsyncMock for `db` so EVERY store call is awaitable — the handler writes the
    # conversation, the generic resource link (not the retired jira_tickets helper,
    # PR #582) and drains pending messages.
    with (
        patch.object(jira_h, "db", new=AsyncMock()),
        patch.object(jira_h, "create_conversation", fake_create),
        patch.object(jira_h, "push_link", new=AsyncMock()),
        patch.object(jira_h, "post_jira_comment", side_effect=rec_post) as post,
        patch.object(jira_h, "conversation_url", lambda cid: f"https://ui/?thread={cid}"),
    ):
        await jira_h._background_create_conversation(
            issue_key="ENG-1", message="hi", conv_title="t",
        )

    assert order == ["ack", "run"]
    assert "conv-xyz" in post.call_args.kwargs["body"]
