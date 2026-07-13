"""Auto-linking: a PR/MR/issue created through the broker proxy is associated
with the caller's conversation (POST /conversations/{id}/links)."""

from __future__ import annotations

import httpx
import pytest

from broker.core.autolink import Link
from broker.providers.github import _GITHUB_LINK_RULES
from broker.providers.gitlab import _GITLAB_LINK_RULES
from broker.providers.jira import _JIRA_LINK_RULES
from broker.transports.http_proxy import HttpProxy


# ---- the per-provider rules extract the right link from a real-ish response ----

def _match(rules, method, path):
    return next((r for r in rules if r.matches(method, path)), None)


def test_github_pr_rule():
    r = _match(_GITHUB_LINK_RULES, "POST", "repos/acme/app/pulls")
    assert r is not None
    link = r.extract({"html_url": "https://github.com/acme/app/pull/7", "title": "Add X"})
    assert link == Link("github", "pr", "https://github.com/acme/app/pull/7", "Add X")


def test_github_issue_rule():
    r = _match(_GITHUB_LINK_RULES, "POST", "repos/acme/app/issues")
    assert r is not None
    assert r.extract({"html_url": "https://github.com/acme/app/issues/3", "title": "Bug"}).resource_type == "issue"


def test_github_rules_do_not_match_reads_or_comments():
    # A GET, and a POST to a NON-create path (issue comments) must not link.
    assert _match(_GITHUB_LINK_RULES, "GET", "repos/acme/app/pulls") is None
    assert _match(_GITHUB_LINK_RULES, "POST", "repos/acme/app/issues/3/comments") is None


def test_gitlab_mr_rule():
    # Transparent proxy (bare-host upstream) -> the path includes the api/v4 prefix.
    r = _match(_GITLAB_LINK_RULES, "POST", "api/v4/projects/42/merge_requests")
    assert r.extract({"web_url": "https://gitlab.com/acme/app/-/merge_requests/9", "title": "MR"}) == Link(
        "gitlab", "mr", "https://gitlab.com/acme/app/-/merge_requests/9", "MR"
    )


def test_gitlab_encoded_project_path_matches():
    # project id may be url-encoded group%2Fproject.
    assert _match(_GITLAB_LINK_RULES, "POST", "api/v4/projects/acme%2Fapp/issues") is not None


def test_gitlab_rule_does_not_match_the_old_prefixless_path():
    # Guards the double-prefix fix: the old /gitlab/projects/... contract is gone.
    assert _match(_GITLAB_LINK_RULES, "POST", "projects/42/merge_requests") is None


def test_jira_issue_rule_builds_browse_url(monkeypatch):
    import broker.providers.jira as jira_mod
    monkeypatch.setattr(jira_mod.settings, "jira_site_url", "https://acme.atlassian.net")
    r = _match(_JIRA_LINK_RULES, "POST", "rest/api/3/issue")
    link = r.extract({"key": "PROJ-12", "self": "https://api.atlassian.com/.../issue/10001"})
    assert link.url == "https://acme.atlassian.net/browse/PROJ-12"
    assert link.resource_type == "issue"


def test_jira_falls_back_to_self_url_when_no_site(monkeypatch):
    import broker.providers.jira as jira_mod
    monkeypatch.setattr(jira_mod.settings, "jira_site_url", "")
    r = _match(_JIRA_LINK_RULES, "POST", "rest/api/2/issue")
    link = r.extract({"key": "PROJ-1", "self": "https://api.atlassian.com/self"})
    assert link.url == "https://api.atlassian.com/self"


# ---- the transport posts a link on a 2xx create, and NOT otherwise ----


@pytest.mark.asyncio
async def test_maybe_autolink_posts_on_match(monkeypatch):
    posted: list = []

    async def fake_post_link(agent_host_url, conversation_id, link):
        posted.append((agent_host_url, conversation_id, link))

    import broker.transports.http_proxy as hp
    monkeypatch.setattr(hp, "post_link", fake_post_link)

    proxy = HttpProxy(
        upstream="https://api.github.com",
        link_rules=_GITHUB_LINK_RULES,
        agent_host_url="http://agent-host:8080",
    )
    resp = httpx.Response(201, json={"html_url": "https://github.com/a/b/pull/1", "title": "T"})
    await proxy._maybe_autolink("POST", "repos/a/b/pulls", resp, "conv-1")

    assert len(posted) == 1
    _, conv, link = posted[0]
    assert conv == "conv-1"
    assert link.url == "https://github.com/a/b/pull/1"


@pytest.mark.asyncio
async def test_maybe_autolink_ignores_non_matching_path(monkeypatch):
    posted: list = []
    import broker.transports.http_proxy as hp
    monkeypatch.setattr(hp, "post_link", lambda *a: posted.append(a))
    proxy = HttpProxy(upstream="x", link_rules=_GITHUB_LINK_RULES, agent_host_url="http://h")
    # A comment POST — not a create rule.
    resp = httpx.Response(201, json={"html_url": "https://github.com/a/b/issues/1#c"})
    await proxy._maybe_autolink("POST", "repos/a/b/issues/1/comments", resp, "conv-1")
    assert posted == []


@pytest.mark.asyncio
async def test_maybe_autolink_swallows_bad_response(monkeypatch):
    # A non-JSON / unexpected body must not raise (best-effort).
    import broker.transports.http_proxy as hp
    monkeypatch.setattr(hp, "post_link", lambda *a: None)
    proxy = HttpProxy(upstream="x", link_rules=_GITHUB_LINK_RULES, agent_host_url="http://h")
    resp = httpx.Response(201, content=b"not json")
    await proxy._maybe_autolink("POST", "repos/a/b/pulls", resp, "conv-1")  # must not raise
