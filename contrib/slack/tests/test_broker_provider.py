"""Slack's broker half: the bot-token proxy to slack.com/api and its enable gate, driven through the environment."""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity
from scooter_contrib_slack.broker_provider import slack


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)


def test_provider_proxies_slack_api_with_the_bot_token(monkeypatch):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-123")

    provider = slack()
    assert provider.name == "slack"
    assert provider.enabled
    proxy = next(t for t in provider.transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://slack.com/api"
    assert set(proxy.methods) == {"GET", "POST"}


@pytest.mark.asyncio
async def test_the_token_is_injected_not_handed_to_the_agent(monkeypatch):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-123")

    cred = await slack().credential.get(_identity())
    req = httpx.Request("POST", "https://slack.com/api/chat.postMessage")
    cred.inject(req)
    assert req.headers["Authorization"] == "Bearer xoxb-123"


def test_no_token_disables_the_provider():
    assert not slack().enabled


def test_the_proxy_does_not_swallow_the_awaiting_input_route(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-123")
    sent: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json={"ok": True, "ts": "1.0"})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: real(*a, transport=httpx.MockTransport(handler), **kw))

    async def approver() -> Identity:
        return Identity("", "agent-sandbox", "system:serviceaccount:agent-sandbox:agent-host", is_approver=True)

    # Mounted in the provider's order, as the broker app does.
    provider = slack()
    app = FastAPI()
    for t in provider.transports:
        app.include_router(t.routes(provider, authed=approver), prefix="/slack")
    notice = {
        "conversationId": "c1",
        "links": [{"source": "slack", "ref": {"channel": "C1", "thread_ts": "1.0"}}],
        "interrupt": {"id": "i1", "message": "Proceed?", "options": []},
    }
    r = TestClient(app).post("/slack/awaiting-input", json=notice)
    assert r.status_code == 200, r.text
    assert [str(s.url) for s in sent] == ["https://slack.com/api/chat.postMessage"]


@pytest.mark.asyncio
async def test_files_host_is_a_read_only_forge_host(monkeypatch):
    from scooter_broker_lib.forge import ForgeHosts, ForgeRequest

    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-123")
    provider = slack()
    forge = next(t for t in provider.transports if isinstance(t, ForgeHosts))
    assert [h.host for h in forge.hosts] == ["files.slack.com"]

    def req(method, host="files.slack.com"):
        return ForgeRequest(identity=_identity(), provider="slack", via="forge-proxy", method=method,
                            host=host, path="/files-pri/T1-F1/doc.pdf", query="", kind="api")

    assert (await provider.forge_policy.check(req("GET"))).allowed
    assert not (await provider.forge_policy.check(req("POST"))).allowed
    assert (await provider.forge_policy.check(req("POST", host="slack.com"))).allowed


def test_the_proxy_posts_to_slack_api_despite_the_files_policy(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-123")
    sent: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json={"ok": True, "ts": "1.0"})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: real(*a, transport=httpx.MockTransport(handler), **kw))

    async def sandbox() -> Identity:
        return _identity()

    provider = slack()
    app = FastAPI()
    proxy = next(t for t in provider.transports if isinstance(t, HttpProxy))
    app.include_router(proxy.routes(provider, authed=sandbox), prefix="/slack")
    r = TestClient(app).post("/slack/chat.postMessage", json={"channel": "C1", "text": "hi"})
    assert r.status_code == 200, r.text
    assert [str(s.url) for s in sent] == ["https://slack.com/api/chat.postMessage"]
