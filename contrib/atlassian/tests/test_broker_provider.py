"""Atlassian provider: product gating, the dot-segment guard, enable gating and the Jira issue link."""

from __future__ import annotations

import time

import httpx
import pytest

from scooter_broker_lib.forge import ForgeHosts, ForgeRequest
from scooter_broker_lib.types import Identity
from scooter_contrib_atlassian.broker_provider import atlassian
from scooter_contrib_jira.atlassian_oauth import AtlassianOAuthSource

IDENT = Identity(conversation_id="c", namespace="ns", service_account="sa")


@pytest.fixture
def env(monkeypatch):
    for k, v in {
        "ATLASSIAN_CLIENT_ID": "cid",
        "ATLASSIAN_CLIENT_SECRET": "sec",
        "ATLASSIAN_CLOUD_ID": "c1",
        "ATLASSIAN_SITE_URL": "https://acme.atlassian.net",
        "ATLASSIAN_PRODUCTS": "jira confluence",
    }.items():
        monkeypatch.setenv(k, v)
    return monkeypatch


def _forge(provider) -> ForgeHosts:
    (t,) = provider.transports
    return t


def test_only_the_api_host_is_intercepted_for_each_enabled_product(env):
    p = atlassian()
    assert p.enabled
    (api,) = _forge(p).hosts
    assert api.host == "api.atlassian.com"
    assert api.api_prefixes == ("/ex/jira/c1/", "/ex/confluence/c1/")


def test_a_disabled_product_gets_no_prefix(env):
    env.setenv("ATLASSIAN_PRODUCTS", "confluence")
    (api,) = _forge(atlassian()).hosts
    assert api.api_prefixes == ("/ex/confluence/c1/",)


@pytest.mark.parametrize("unset", ["ATLASSIAN_CLIENT_ID", "ATLASSIAN_CLIENT_SECRET", "ATLASSIAN_CLOUD_ID"])
def test_missing_credential_disables_the_provider(env, unset):
    env.delenv(unset)
    assert not atlassian().enabled


def test_no_products_disables_the_provider(env):
    env.setenv("ATLASSIAN_PRODUCTS", "")
    assert not atlassian().enabled


def test_unknown_product_disables_the_provider(env):
    env.setenv("ATLASSIAN_PRODUCTS", "jira bitbucket")
    assert not atlassian().enabled


def _req(path: str, kind: str = "api") -> ForgeRequest:
    return ForgeRequest(identity=IDENT, provider="atlassian", via="forge-proxy", method="GET",
                        host="api.atlassian.com", path=path, kind=kind)


@pytest.mark.asyncio
@pytest.mark.parametrize("path", [
    "/ex/jira/c1/../../ex/confluence/c1/wiki",
    "/ex/jira/c1/%2e%2e/%2E%2E/ex/confluence/c1/wiki",
    "/ex/jira/c1/./rest",
    "/ex/jira/c1/..%5c..%5cex",
])
async def test_dot_segments_cannot_leave_a_product(env, path):
    policy = atlassian().forge_policy
    assert not (await policy.check(_req(path))).allowed
    assert (await policy.check(_req("/ex/jira/c1/rest/api/3/myself"))).allowed


def _issue_rule(provider):
    (r,) = _forge(provider).link_rules
    return r


def test_created_issue_links_to_its_browse_page(env):
    r = _issue_rule(atlassian())
    assert r.matches("POST", "ex/jira/c1/rest/api/3/issue")
    assert r.matches("POST", "ex/jira/c1/rest/api/2/issue/")
    assert not r.matches("POST", "ex/jira/c1/rest/api/3/issue/bulk")
    assert not r.matches("GET", "ex/jira/c1/rest/api/3/issue")
    link = r.extract({"key": "ENG-7", "self": "https://api.atlassian.com/ex/jira/c1/rest/api/3/issue/1"})
    assert (link.source, link.resource_type, link.url, link.title) == (
        "jira", "issue", "https://acme.atlassian.net/browse/ENG-7", "ENG-7",
    )
    assert r.extract({"id": "1"}) is None


def test_without_a_site_the_issue_link_is_the_api_self_url(env):
    env.delenv("ATLASSIAN_SITE_URL")
    link = _issue_rule(atlassian()).extract({"key": "ENG-7", "self": "https://api.atlassian.com/x/1"})
    assert link.url == "https://api.atlassian.com/x/1"


def test_no_issue_link_rule_with_jira_off(env):
    env.setenv("ATLASSIAN_PRODUCTS", "confluence")
    assert _forge(atlassian()).link_rules == []


@pytest.mark.asyncio
async def test_oauth_source_mints_and_caches(monkeypatch):
    calls = []

    async def fake_post(self, url, **kwargs):  # noqa: ANN001
        calls.append((url, kwargs["json"]))
        return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    src = AtlassianOAuthSource(client_id="cid", client_secret="sec", cloud_id="c1")
    cred = await src.get(IDENT)
    assert (cred.kind, cred.value) == ("bearer", "tok")
    assert cred.expires_at and cred.expires_at > time.time()
    await src.get(IDENT)
    assert calls == [("https://auth.atlassian.com/oauth/token",
                      {"grant_type": "client_credentials", "client_id": "cid", "client_secret": "sec"})]
