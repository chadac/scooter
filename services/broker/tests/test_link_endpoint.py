"""The broker's explicit /link endpoints — the agent-facing complement to the
auto-link injector. An agent (via `agent-broker link ...`) can attach a link the
injector missed and list what's currently linked. The conversation is always
taken from the caller's SA token, never a request field."""

from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

import broker.core.app as app_mod
from broker.core.app import create_app
from broker.core.auth import authenticate
from broker.core.types import Identity


def _fake_identity() -> Identity:
    return Identity(
        conversation_id="conv-link1",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:sandbox-conv-link1",
    )


def _client() -> TestClient:
    app = create_app()
    app.dependency_overrides[authenticate] = _fake_identity
    return TestClient(app)


def test_post_link_forwards_to_agent_host(monkeypatch):
    captured: dict = {}

    async def fake_create_link(agent_host_url, conversation_id, link):
        captured.update(url=agent_host_url, conv=conversation_id, link=link)

    monkeypatch.setattr(app_mod, "create_link", fake_create_link)
    monkeypatch.setattr(app_mod.settings, "agent_host_url", "http://agent-host:8080")

    resp = _client().post(
        "/link",
        json={"source": "github", "resourceType": "pr", "url": "https://x/pull/1", "title": "T"},
    )

    assert resp.status_code == 201
    assert resp.json() == {"status": "linked"}
    # conversation comes from the token, not the body
    assert captured["conv"] == "conv-link1"
    assert captured["link"].url == "https://x/pull/1"
    assert captured["link"].resource_type == "pr"


def test_post_link_accepts_type_alias(monkeypatch):
    captured: dict = {}

    async def fake_create_link(agent_host_url, conversation_id, link):
        captured["link"] = link

    monkeypatch.setattr(app_mod, "create_link", fake_create_link)
    resp = _client().post("/link", json={"source": "jira", "type": "issue", "url": "https://x/PROJ-1"})
    assert resp.status_code == 201
    assert captured["link"].resource_type == "issue"


def test_post_link_rejects_missing_fields():
    resp = _client().post("/link", json={"source": "github", "url": ""})
    assert resp.status_code == 400


def test_post_link_maps_agent_host_error_to_502(monkeypatch):
    async def boom(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(app_mod, "create_link", boom)
    resp = _client().post("/link", json={"source": "github", "resourceType": "pr", "url": "https://x/1"})
    assert resp.status_code == 502


def test_post_link_maps_no_conversation_to_409(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("no conversation for this identity — cannot attach a link")

    monkeypatch.setattr(app_mod, "create_link", boom)
    resp = _client().post("/link", json={"source": "github", "resourceType": "pr", "url": "https://x/1"})
    assert resp.status_code == 409


def test_get_link_lists_current_links(monkeypatch):
    async def fake_list_links(agent_host_url, conversation_id):
        assert conversation_id == "conv-link1"
        return [{"source": "github", "resourceType": "pr", "url": "https://x/pull/1"}]

    monkeypatch.setattr(app_mod, "list_links", fake_list_links)
    resp = _client().get("/link")
    assert resp.status_code == 200
    assert resp.json() == {"links": [{"source": "github", "resourceType": "pr", "url": "https://x/pull/1"}]}


def test_get_link_maps_agent_host_error_to_502(monkeypatch):
    async def boom(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(app_mod, "list_links", boom)
    resp = _client().get("/link")
    assert resp.status_code == 502


def test_link_endpoints_require_auth():
    # No dependency override -> real authenticate rejects an unauthenticated caller.
    app = create_app()
    client = TestClient(app)
    assert client.get("/link").status_code in (401, 403)
    assert client.post("/link", json={}).status_code in (401, 403)
