"""The slack handler through the real extension seam: its gating answers, and its owner lookup and resource shapes arm on import."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_contrib_slack import webhooks_handler as slack_h


@pytest.fixture
def client():
    """A minimal app with only this contrib's router mounted."""
    app = FastAPI()
    app.include_router(slack_h.router)
    return TestClient(app)


def test_slack_webhook_disabled(client):
    """The off toggle answers `disabled` in-route rather than unmounting."""
    with patch.object(slack_h, "settings") as mock_settings:
        mock_settings.slack_enabled = False
        resp = client.post("/webhooks/slack", json={})
        assert resp.json()["status"] == "disabled"


def test_slack_webhook_rejects_all_without_a_secret(client, caplog):
    with patch.object(slack_h, "settings") as mock_settings:
        mock_settings.slack_enabled = True
        mock_settings.slack_signing_secret = ""
        resp = client.post(
            "/webhooks/slack",
            headers={"X-Slack-Request-Timestamp": "0", "X-Slack-Signature": ""},
            json={"type": "event_callback"},
        )
        assert resp.status_code == 401
        assert "SLACK_SIGNING_SECRET is not set" in caplog.text


def test_slack_event_deduped_by_event_id(client):
    """A redelivered event_id is processed exactly once."""
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
        second = client.post("/webhooks/slack", json=payload)

    assert first.json()["status"] == "ok"
    assert second.json().get("deduped") is True
    assert mock_handle.await_count == 1


def test_importing_the_handler_arms_the_resource_shapes():
    """Shapes register by import side effect and nothing else imports them."""
    from scooter_webhooks_lib import resources

    assert "slack" in resources.registered_sources()


def test_importing_the_handler_arms_the_owner_lookup():
    """Without the resolver every Slack-spawned conversation silently becomes unowned."""
    from scooter_webhooks_lib import identity

    assert "slack" in identity.registered_providers()


async def test_slack_ack_posts_before_the_run():
    """The 'Scooter is on it' ack posts inside the `on_created` hook, before the agent run."""
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


def test_weave_appends_inline_text_then_skipped_notices():
    from scooter_contrib_slack.files import DownloadedFiles, Skipped

    dl = DownloadedFiles(
        inline_text="[Attached file: a.txt]",
        skipped=[Skipped(name="b.mov", mimetype="", size=None, reason="the download failed", url="")],
    )
    assert slack_h._weave_attachments("hi", dl) == (
        "hi\n\n[Attached file: a.txt]\n\n[Attachment not forwarded: b.mov: the download failed.]"
    )
    assert slack_h._weave_attachments("hi", DownloadedFiles()) == "hi"
