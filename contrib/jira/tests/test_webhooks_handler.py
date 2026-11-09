"""The jira handler through the real extension seam: its gating answers, and its resource shapes arm on import."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_contrib_jira import webhooks_handler as jira_h
from scooter_webhooks_lib import tasks


@pytest.fixture
def client():
    """A minimal app with only this contrib's router mounted."""
    app = FastAPI()
    app.include_router(jira_h.router)
    return TestClient(app)


def test_jira_webhook_disabled(client):
    """The off toggle answers `disabled` in-route rather than unmounting."""
    with patch.object(jira_h, "settings") as mock_settings:
        mock_settings.jira_enabled = False
        resp = client.post("/webhooks/jira", json={})
        assert resp.json()["status"] == "disabled"


def test_importing_the_handler_arms_the_resource_shapes():
    """Shapes register by import side effect and nothing else imports them."""
    from scooter_webhooks_lib import resources

    assert "jira" in resources.registered_sources()


async def test_jira_ack_posts_before_the_run():
    """The 'Scooter is on it' ack posts inside the `on_created` hook, before the agent run."""
    order: list[str] = []

    async def rec_post(*a, **k):
        order.append("ack")

    async def fake_create(*args, on_created=None, **kwargs):
        if on_created is not None:
            await on_created("conv-xyz")
        order.append("run")
        return {"conversation_id": "conv-xyz", "result": "done"}

    # AsyncMock for `db` so every store call is awaitable.
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


# --- delivery verification -------------------------------------------------

SECRET = "It's a Secret to Everybody"


def _sign(body: bytes, secret: str = SECRET, method: str = "sha256") -> str:
    import hashlib
    import hmac

    return f"{method}=" + hmac.new(secret.encode(), body, getattr(hashlib, method)).hexdigest()


@pytest.fixture
def jira_settings():
    """Enabled with a secret; tests override fields as needed."""
    with patch.object(jira_h, "settings") as s:
        s.jira_enabled = True
        s.jira_webhook_secret = SECRET
        s.jira_bot_account_id = ""
        yield s


def test_signature_matches_atlassian_vector(jira_settings):
    """The worked example from Atlassian's webhook docs."""
    assert jira_h._verify_signature(
        b"Hello World!",
        "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
    )


@pytest.mark.parametrize("header", [
    "",
    "sha256=",
    "sha256=deadbeef",
    "a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
    "md5=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
])
def test_bad_signatures_rejected(jira_settings, header):
    assert not jira_h._verify_signature(b"Hello World!", header)


def test_other_websub_methods_accepted(jira_settings):
    assert jira_h._verify_signature(b"x", _sign(b"x", method="sha512"))


def test_unsigned_delivery_is_401(client, jira_settings):
    with patch.object(jira_h, "_handle_comment", new=AsyncMock()) as handle:
        resp = client.post("/webhooks/jira", json={"webhookEvent": "comment_created"})
    assert resp.status_code == 401
    handle.assert_not_called()


def test_wrongly_signed_delivery_is_401(client, jira_settings):
    body = b'{"webhookEvent": "comment_created"}'
    with patch.object(jira_h, "_handle_comment", new=AsyncMock()) as handle:
        resp = client.post(
            "/webhooks/jira", content=body,
            headers={"X-Hub-Signature": _sign(body, secret="wrong"), "Content-Type": "application/json"},
        )
    assert resp.status_code == 401
    handle.assert_not_called()


def test_no_secret_configured_is_401_even_if_signed(client, jira_settings):
    """Fails closed: an unset secret refuses every delivery rather than accepting all."""
    jira_settings.jira_webhook_secret = ""
    body = b'{"webhookEvent": "comment_created"}'
    with patch.object(jira_h, "_handle_comment", new=AsyncMock()) as handle:
        resp = client.post(
            "/webhooks/jira", content=body,
            headers={"X-Hub-Signature": _sign(body, secret=""), "Content-Type": "application/json"},
        )
    assert resp.status_code == 401
    handle.assert_not_called()


async def test_correctly_signed_delivery_is_handled(jira_settings):
    body = b'{"webhookEvent": "comment_created", "comment": {"body": "hi"}}'
    app = FastAPI()
    app.include_router(jira_h.router)
    with patch.object(jira_h, "_handle_comment", new=AsyncMock()) as handle:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
            resp = await client.post(
                "/webhooks/jira", content=body,
                headers={"X-Hub-Signature": _sign(body), "Content-Type": "application/json"},
            )
        await tasks.drain(timeout=5)
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
    handle.assert_awaited_once()


# --- label trigger -----------------------------------------------------------

def _label_event(from_s: str, to_s: str) -> dict:
    return {
        "webhookEvent": "jira:issue_updated",
        "issue": {"key": "ENG-7", "fields": {"summary": "s", "description": "d"}},
        "changelog": {"items": [{"field": "labels", "fromString": from_s, "toString": to_s}]},
    }


async def _run_issue_updated(payload: dict) -> AsyncMock:
    db = AsyncMock()
    db.lookup_conversation.return_value = None
    db.get_conversation_for_resource.return_value = None
    with (
        patch.object(jira_h, "db", new=db),
        patch.object(jira_h, "_background_create_conversation", new=AsyncMock()) as bg,
    ):
        await jira_h._handle_issue_updated(payload)
        import asyncio
        await asyncio.sleep(0)
    return bg


async def test_adding_configured_trigger_label_starts_conversation(trigger_policy):
    bg = await _run_issue_updated(_label_event("bug", "bug Scooter"))
    bg.assert_called_once()
    assert bg.call_args.kwargs["issue_key"] == "ENG-7"


async def test_custom_label_trigger_is_honoured(trigger_policy):
    trigger_policy.label_trigger = "ai-please"
    assert (await _run_issue_updated(_label_event("", "scooter"))).call_count == 0
    assert (await _run_issue_updated(_label_event("", "ai-please"))).call_count == 1


async def test_openhands_label_no_longer_triggers(trigger_policy):
    assert (await _run_issue_updated(_label_event("", "openhands"))).call_count == 0


async def test_trigger_label_already_present_does_not_retrigger(trigger_policy):
    """Editing other labels on an issue that already has the trigger label is not an add."""
    assert (await _run_issue_updated(_label_event("scooter", "scooter bug"))).call_count == 0
