"""Slack owner resolution: a Slack user id -> the email Scooter matches on.

Moved out of the webhooks app's test_identity_resolve with the resolver (PR #588).
The generic chain (email -> agent-host /users/by-email) stays covered there and in
the lib; what is slack's own is the users.info call and its gating.
"""

from __future__ import annotations

import httpx
import pytest

from scooter_contrib_slack import identity as slack_identity
from scooter_contrib_slack.config import settings
from scooter_webhooks_lib import identity as lib_identity

pytestmark = pytest.mark.asyncio


def _patch(monkeypatch, handler):
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(slack_identity.httpx, "AsyncClient", factory)


async def test_slack_email(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-1", raising=False)

    def handler(req):
        assert "users.info" in str(req.url)
        assert req.headers["authorization"] == "Bearer xoxb-1"
        return httpx.Response(200, json={"ok": True, "user": {"profile": {"email": "a@x.io"}}})

    _patch(monkeypatch, handler)
    # Through the lib registry, not the function: the registration is what the
    # webhooks service actually calls.
    assert await lib_identity.get_user_email("slack", "U123") == "a@x.io"


async def test_slack_email_not_ok(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-1", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, json={"ok": False, "error": "user_not_found"}))
    assert await lib_identity.get_user_email("slack", "U123") is None


async def test_slack_email_no_token(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "", raising=False)
    assert await lib_identity.get_user_email("slack", "U123") is None


async def test_no_raw_slack_id_reaches_a_log_field(monkeypatch, caplog):
    """An identifier is personal data: it must reach a log line only pseudonymized,
    since a structured field is searchable and inherits the store's retention."""
    import logging

    secret_id = "U-SECRET-SLACK-ID"
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-1", raising=False)

    def boom(req):
        raise httpx.HTTPError("upstream down")

    _patch(monkeypatch, boom)

    with caplog.at_level(logging.WARNING):
        await lib_identity.get_user_email("slack", secret_id)

    assert caplog.records, "expected a warning to be logged"
    for rec in caplog.records:
        assert secret_id not in rec.getMessage()
        for key, value in rec.__dict__.items():
            assert secret_id != value, f"raw identifier leaked as field {key}"
        assert getattr(rec, "external_user", None) == lib_identity.pseudonym(secret_id)
