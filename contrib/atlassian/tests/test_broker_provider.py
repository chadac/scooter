"""Atlassian provider: product gating, the site rewrite, enable gating and the Jira issue link."""

from __future__ import annotations

import pytest

from scooter_broker_lib.forge import ForgeHosts, Rewrite
from scooter_contrib_atlassian.broker_provider import atlassian, forge_hosts


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


def test_every_enabled_product_and_the_site_are_intercepted(env):
    p = atlassian()
    assert p.enabled
    api, site = _forge(p).hosts
    assert api.host == "api.atlassian.com"
    assert api.api_prefixes == ("/ex/jira/c1/", "/ex/confluence/c1/")
    assert site.host == "acme.atlassian.net" and site.api_prefixes == ()
    assert site.rewrites == (
        Rewrite("/rest/", "api.atlassian.com", "/ex/jira/c1/rest/"),
        Rewrite("/wiki/", "api.atlassian.com", "/ex/confluence/c1/wiki/"),
    )


def test_a_disabled_product_gets_no_prefix_and_no_rewrite():
    api, site = forge_hosts("c1", ["confluence"], "acme.atlassian.net")
    assert api.api_prefixes == ("/ex/confluence/c1/",)
    assert site.rewrite("/rest/api/3/myself") is None
    assert site.rewrite("/wiki/api/v2/pages") == ("api.atlassian.com", "/ex/confluence/c1/wiki/api/v2/pages")


def test_without_a_site_only_the_api_host_is_intercepted(env):
    env.delenv("ATLASSIAN_SITE_URL")
    assert [h.host for h in _forge(atlassian()).hosts] == ["api.atlassian.com"]


@pytest.mark.parametrize("unset", ["ATLASSIAN_CLIENT_ID", "ATLASSIAN_CLIENT_SECRET", "ATLASSIAN_CLOUD_ID"])
def test_missing_credential_disables_the_provider(env, unset):
    env.delenv(unset)
    assert not atlassian().enabled


def test_no_products_disables_the_provider(env):
    env.setenv("ATLASSIAN_PRODUCTS", "")
    assert not atlassian().enabled


@pytest.mark.parametrize("var,value", [
    ("ATLASSIAN_PRODUCTS", "jira bitbucket"),
    ("ATLASSIAN_SITE_URL", "http://acme.atlassian.net"),
    ("ATLASSIAN_SITE_URL", "https://acme.atlassian.net/jira"),
])
def test_bad_config_disables_the_provider(env, var, value):
    env.setenv(var, value)
    assert not atlassian().enabled


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
