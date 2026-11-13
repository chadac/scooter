"""Atlassian provider: product gating, enable gating, the issue and page links, and Confluence's tools."""

from __future__ import annotations

import time

import httpx
import pytest

from scooter_broker_lib.forge import ForgeHosts, find_forge_hosts
from scooter_broker_lib.transports.mcp_tools import McpTools
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
    return find_forge_hosts(provider)


def _tools(provider) -> list[McpTools]:
    return [t for t in provider.transports if isinstance(t, McpTools)]


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


def _issue_rule(provider):
    (r,) = [r for r in _forge(provider).link_rules if r.matches("POST", "ex/jira/c1/rest/api/3/issue")]
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
    assert not any(r.matches("POST", "ex/jira/c1/rest/api/3/issue") for r in _forge(atlassian()).link_rules)


def _page_link(path: str, response: dict):
    rules = [r for r in _forge(atlassian()).link_rules if r.matches("POST", path)]
    return rules[0].extract(response) if rules else "no rule"


PAGE = {"id": "77", "title": "Plan", "_links": {"webui": "/spaces/ENG/pages/77/Plan"}}


def test_created_v2_page_links_to_its_site_page(env):
    link = _page_link("ex/confluence/c1/wiki/api/v2/pages", PAGE)
    assert (link.source, link.resource_type, link.url, link.title) == (
        "atlassian-confluence", "page", "https://acme.atlassian.net/wiki/spaces/ENG/pages/77/Plan", "Plan",
    )


def test_created_v1_content_links_only_pages(env):
    v1 = "ex/confluence/c1/wiki/rest/api/content/"
    based = {**PAGE, "type": "page", "_links": {**PAGE["_links"], "base": "https://other.atlassian.net/wiki"}}
    assert _page_link(v1, based).url == "https://other.atlassian.net/wiki/spaces/ENG/pages/77/Plan"
    assert _page_link(v1, {**PAGE, "type": "blogpost"}) is None
    assert _page_link(v1, {**PAGE, "type": "comment"}) is None


@pytest.mark.parametrize("path", [
    "ex/confluence/c1/wiki/api/v2/pages/77",
    "ex/confluence/c1/wiki/api/v2/footer-comments",
    "ex/confluence/c1/wiki/rest/api/content/77/child/attachment",
])
def test_other_confluence_posts_are_not_linked(env, path):
    assert _page_link(path, PAGE) == "no rule"


def test_without_a_site_or_base_no_page_is_linked(env):
    env.delenv("ATLASSIAN_SITE_URL")
    assert _page_link("ex/confluence/c1/wiki/api/v2/pages", PAGE) is None


def test_confluence_tools_ship_with_confluence_and_call_its_api_root(env):
    (t,) = _tools(atlassian())
    assert t.upstream == "https://api.atlassian.com/ex/confluence/c1"


def test_no_confluence_tools_or_page_links_with_confluence_off(env):
    env.setenv("ATLASSIAN_PRODUCTS", "jira")
    p = atlassian()
    assert _tools(p) == []
    assert not any(r.matches("POST", "ex/confluence/c1/wiki/api/v2/pages") for r in _forge(p).link_rules)


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
