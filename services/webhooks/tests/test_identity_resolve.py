"""External-user → Scooter-user mapping (identity_resolve): fetch the invoking
user's email per provider, then match a Scooter user via the agent-host /users/by-email.
Best-effort: any miss -> None (unowned). See todo/IDENTITY_MAPPING.md."""

import httpx
import pytest

import webhooks.identity_resolve as ir
from webhooks.config import settings

pytestmark = pytest.mark.asyncio


def _patch(monkeypatch, handler):
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(ir.httpx, "AsyncClient", factory)


# --- per-provider email fetch -------------------------------------------------


async def test_slack_email(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-1", raising=False)

    def handler(req):
        assert "users.info" in str(req.url)
        assert req.headers["authorization"] == "Bearer xoxb-1"
        return httpx.Response(200, json={"ok": True, "user": {"profile": {"email": "a@x.io"}}})

    _patch(monkeypatch, handler)
    assert await ir.get_user_email("slack", "U123") == "a@x.io"


async def test_slack_email_not_ok(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-1", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, json={"ok": False, "error": "user_not_found"}))
    assert await ir.get_user_email("slack", "U123") is None


async def test_slack_email_no_token(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "", raising=False)
    assert await ir.get_user_email("slack", "U123") is None


async def test_github_public_email(monkeypatch):
    monkeypatch.setattr(settings, "github_token", "", raising=False)

    def handler(req):
        assert "/users/octocat" in str(req.url)
        return httpx.Response(200, json={"login": "octocat", "email": "cat@github.com"})

    _patch(monkeypatch, handler)
    assert await ir.get_user_email("github", "octocat") == "cat@github.com"


async def test_github_private_email_is_none(monkeypatch):
    _patch(monkeypatch, lambda req: httpx.Response(200, json={"login": "octocat", "email": None}))
    assert await ir.get_user_email("github", "octocat") is None


async def test_gitlab_email(monkeypatch):
    monkeypatch.setattr(settings, "gitlab_token", "glpat-1", raising=False)

    def handler(req):
        assert req.headers["private-token"] == "glpat-1"
        return httpx.Response(200, json=[{"username": "alice", "email": "alice@gl.io"}])

    _patch(monkeypatch, handler)
    assert await ir.get_user_email("gitlab", "alice") == "alice@gl.io"


async def test_gitlab_no_token(monkeypatch):
    monkeypatch.setattr(settings, "gitlab_token", "", raising=False)
    assert await ir.get_user_email("gitlab", "alice") is None


async def test_unknown_provider(monkeypatch):
    assert await ir.get_user_email("bitbucket", "x") is None


# --- resolve_owner (email -> agent-host by-email) -----------------------------


async def test_resolve_owner_full_chain(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-1", raising=False)
    monkeypatch.setattr(settings, "agent_host_url", "http://agent-host:8080", raising=False)

    def handler(req):
        if "users.info" in str(req.url):
            return httpx.Response(200, json={"ok": True, "user": {"profile": {"email": "a@x.io"}}})
        if "/users/by-email" in str(req.url):
            assert req.url.params.get("email") == "a@x.io"
            return httpx.Response(200, json={"id": "scooter-alice"})
        return httpx.Response(404)

    _patch(monkeypatch, handler)
    assert await ir.resolve_owner("slack", "U123") == "scooter-alice"


async def test_resolve_owner_no_email(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-1", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, json={"ok": True, "user": {"profile": {}}}))
    assert await ir.resolve_owner("slack", "U123") is None


async def test_resolve_owner_no_scooter_match(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-1", raising=False)
    monkeypatch.setattr(settings, "agent_host_url", "http://agent-host:8080", raising=False)

    def handler(req):
        if "users.info" in str(req.url):
            return httpx.Response(200, json={"ok": True, "user": {"profile": {"email": "nobody@x.io"}}})
        return httpx.Response(404)  # by-email: no match

    _patch(monkeypatch, handler)
    assert await ir.resolve_owner("slack", "U123") is None


async def test_resolve_owner_empty_external_id(monkeypatch):
    assert await ir.resolve_owner("slack", "") is None
