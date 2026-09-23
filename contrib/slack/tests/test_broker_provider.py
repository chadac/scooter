"""Slack's broker half: the bot-token proxy to slack.com/api and its enable gate.

The broker app never had a test for this — the provider was three lines of wiring
inside it. It gets one on the way out (PR #588), driven through the ENVIRONMENT
rather than a settings singleton, so the variable name a deployment sets is part
of what is covered.
"""

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
    # POST as well as GET: chat.postMessage / reactions.add are the whole point.
    assert set(proxy.methods) == {"GET", "POST"}


@pytest.mark.asyncio
async def test_the_token_is_injected_not_handed_to_the_agent(monkeypatch):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-123")

    cred = await slack().credential.get(_identity())
    req = httpx.Request("POST", "https://slack.com/api/chat.postMessage")
    cred.inject(req)
    assert req.headers["Authorization"] == "Bearer xoxb-123"


def test_no_token_disables_the_provider():
    # Enabled iff the token is set: without it every /slack/* route would 401
    # upstream, so the broker declines to mount them at all.
    assert not slack().enabled
