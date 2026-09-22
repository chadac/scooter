"""The slack handler, exercised through the real extension seam.

These moved out of the webhooks app's suite with the handler (PR #588). The app no
longer knows slack exists, so what proves the integration is the entry point plus
the registries: discovery finds the handler, its route mounts, its gating answers,
and its owner lookup and resource shapes arm when it is imported.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_contrib_slack import CONTRIB_NAME
from scooter_contrib_slack import webhooks_handler as slack_h


@pytest.fixture
def client():
    """A minimal app with only this contrib's router mounted — no webhooks app."""
    app = FastAPI()
    app.include_router(slack_h.router)
    return TestClient(app)


def test_entrypoints_declared():
    from importlib.metadata import entry_points

    broker_eps = {ep.name: ep.value for ep in entry_points(group="agent_broker.providers")}
    webhook_eps = {ep.name: ep.value for ep in entry_points(group="scooter_webhooks.handlers")}
    assert broker_eps.get("slack") == "scooter_contrib_slack.broker_provider:slack"
    assert webhook_eps.get("slack") == "scooter_contrib_slack.webhooks_handler:slack"


def test_webhooks_discovers_slack_via_entrypoint():
    from scooter_webhooks_lib.registry import discover_webhooks

    handlers = {h.name: h for h in discover_webhooks()}
    assert CONTRIB_NAME in handlers
    paths = {r.path for r in handlers[CONTRIB_NAME].router.routes}
    assert "/webhooks/slack" in paths


def test_slack_webhook_disabled(client):
    """Off toggle answers `disabled` in-route rather than unmounting."""
    with patch.object(slack_h, "settings") as mock_settings:
        mock_settings.slack_enabled = False
        resp = client.post("/webhooks/slack", json={})
        assert resp.json()["status"] == "disabled"


def test_slack_event_deduped_by_event_id(client):
    """Slack redelivers the same event (retries + app_mention/message dual
    delivery). The handler must process a given event_id EXACTLY ONCE, else one
    user message creates two conversations / two replies."""
    slack_h._SEEN_EVENT_IDS.clear()
    payload = {
        "type": "event_callback",
        "event_id": "Ev0DUPLICATE",
        "event": {"type": "app_mention", "user": "U1", "channel": "C1", "ts": "1.0", "text": "hi"},
    }
    with (
        patch.object(slack_h, "settings") as mock_settings,
        patch.object(slack_h, "_verify_slack_signature", return_value=True),
        patch.object(slack_h, "_handle_event", new=AsyncMock()) as mock_handle,
    ):
        mock_settings.slack_enabled = True

        first = client.post("/webhooks/slack", json=payload)
        second = client.post("/webhooks/slack", json=payload)  # retry / dual delivery

    assert first.json()["status"] == "ok"
    assert second.json().get("deduped") is True
    # The event was handled exactly once despite two identical deliveries.
    assert mock_handle.await_count == 1


def test_importing_the_handler_arms_the_resource_shapes():
    """Shapes register by import side effect and nothing else imports them: losing
    that line would make a thread link stop matching the id a webhook arrives with
    (issue #563)."""
    from scooter_webhooks_lib import resources

    assert "slack" in resources.registered_sources()


def test_importing_the_handler_arms_the_owner_lookup():
    """Same hazard, different failure: without the resolver every Slack-spawned
    conversation silently becomes unowned (#575)."""
    from scooter_webhooks_lib import identity

    assert "slack" in identity.registered_providers()


async def test_slack_ack_posts_before_the_run():
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

    with (
        patch.object(slack_h, "db", new=AsyncMock()) as db,
        patch.object(slack_h, "create_conversation", fake_create),
        patch.object(slack_h, "push_link", new=AsyncMock()),
        patch.object(slack_h, "resolve_owner", new=AsyncMock(return_value=None)),
        patch.object(slack_h, "post_slack_message", side_effect=rec_post) as post,
        patch.object(slack_h, "conversation_url", lambda cid: f"https://ui/?thread={cid}"),
    ):
        db.get_and_clear_pending_messages = AsyncMock(return_value=[])
        await slack_h._background_create_conversation(
            res_id="C1:1.0", message="hi", conv_title="t", channel="C1", thread_ts="1.0",
        )

    assert order == ["ack", "run"], "the ack must post BEFORE the run finishes"
    body = post.call_args.kwargs["text"]
    assert "follow along" in body and "conv-xyz" in body
