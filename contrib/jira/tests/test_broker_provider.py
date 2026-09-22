"""Jira's broker half: the Atlassian OAuth source and the auto-link rule.

Moved out of the broker's test_sources / test_autolink with the provider
(PR #582). The token flow is jira implementation, not shared surface — the
generic `static_token` source stays covered in scooter_broker_lib.
"""

from __future__ import annotations

import time

import httpx
import pytest

from scooter_broker_lib.autolink import Link
from scooter_broker_lib.types import Identity

from scooter_contrib_jira.atlassian_oauth import AtlassianOAuthSource
from scooter_contrib_jira.broker_provider import _JIRA_LINK_RULES


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


def _match(rules, method: str, path: str):
    return next((r for r in rules if r.matches(method, path)), None)


@pytest.mark.asyncio
async def test_atlassian_oauth_source_mints_and_caches(monkeypatch):
    calls = {"n": 0}

    async def fake_post(self, url, **kwargs):  # noqa: ANN001
        calls["n"] += 1
        assert "oauth/token" in url
        assert kwargs["json"]["grant_type"] == "client_credentials"
        return httpx.Response(
            200,
            json={"access_token": "atl_token", "expires_in": 3600},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    src = AtlassianOAuthSource(client_id="cid", client_secret="sec", cloud_id="cloud")
    cred = await src.get(_identity())
    assert cred.value == "atl_token"
    assert cred.expires_at and cred.expires_at > time.time()

    await src.get(_identity())
    assert calls["n"] == 1  # cached


def test_jira_issue_rule_builds_browse_url(monkeypatch):
    # The contrib owns JIRA_SITE_URL now, so the env is what configures the link —
    # the broker app has no jira field to patch. Why: PR #582.
    monkeypatch.setenv("JIRA_SITE_URL", "https://acme.atlassian.net")
    r = _match(_JIRA_LINK_RULES, "POST", "rest/api/3/issue")
    link = r.extract({"key": "PROJ-12", "self": "https://api.atlassian.com/.../issue/10001"})
    assert link.url == "https://acme.atlassian.net/browse/PROJ-12"
    assert link.resource_type == "issue"


def test_without_a_site_url_the_api_self_link_is_used():
    # Empty is a MODE: no site configured -> fall back to the API `self` URL rather
    # than building a link to a host we are guessing at.
    r = _match(_JIRA_LINK_RULES, "POST", "rest/api/2/issue")
    link = r.extract({"key": "PROJ-12", "self": "https://api.atlassian.com/x/issue/10001"})
    assert link == Link("jira", "issue", "https://api.atlassian.com/x/issue/10001", "PROJ-12")


def test_bulk_create_is_excluded():
    assert _match(_JIRA_LINK_RULES, "POST", "rest/api/3/issue/bulk") is None
