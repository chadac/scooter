"""The github provider's transports: the api.github.com proxy, the App credential and the forge-proxy hosts."""

from __future__ import annotations

from scooter_contrib_github.broker_provider import github
from scooter_broker_lib.transports.http_proxy import HttpProxy


def test_proxy_targets_github_api():
    provider = github()
    proxy = next(t for t in provider.transports if isinstance(t, HttpProxy))
    assert "api.github.com" in proxy.upstream


def test_app_settings_select_the_app_source(monkeypatch):
    """With the App configured the provider's credential is a GitHubAppSource."""
    from scooter_contrib_github.github_app import GitHubAppSource

    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "42")

    provider = github()
    assert provider.enabled
    assert isinstance(provider.credential, GitHubAppSource)
    assert provider.credential.installation_id == 42


def test_forge_proxy_intercepts_github_hosts():
    from scooter_contrib_github.forge import GitHubDialect
    from scooter_broker_lib.forge import ALLOW_ALL, find_forge_hosts

    provider = github()
    forge = find_forge_hosts(provider)
    assert forge is not None
    assert {h.host for h in forge.hosts} == {"github.com", "api.github.com", "uploads.github.com"}
    assert [h.host for h in forge.hosts if h.git] == ["github.com"]
    assert isinstance(forge.dialect, GitHubDialect)
    assert forge.dialect.api_repo("/repos/o/r/pulls") == "o/r"
    assert forge.dialect.api_repo("/api/v3/repos/o/r") == "o/r"
    assert forge.dialect.is_graphql("/graphql")
    assert provider.forge_policy is ALLOW_ALL


def test_github_host_setting_points_everything_at_ghes(monkeypatch):
    from scooter_broker_lib.forge import find_forge_hosts

    monkeypatch.setenv("GITHUB_HOST", "ghe.example.com")
    provider = github()
    [host] = find_forge_hosts(provider).hosts
    assert (host.host, host.git, host.api_prefixes) == ("ghe.example.com", True, ("/api/",))
    [proxy] = [t for t in provider.transports if isinstance(t, HttpProxy)]
    assert proxy.upstream == "https://ghe.example.com/api/v3"


def test_gh_graphql_creates_are_linked():
    from scooter_broker_lib.forge import find_forge_hosts

    rules = find_forge_hosts(github()).graphql_link_rules
    pr = rules["createPullRequest"]({"pullRequest": {"url": "https://github.com/o/r/pull/7", "title": "T"}}, {})
    assert (pr.resource_type, pr.url, pr.title) == ("pr", "https://github.com/o/r/pull/7", "T")
    assert rules["createIssue"]({"issue": {"url": "https://github.com/o/r/issues/8"}}, {}).resource_type == "issue"
    assert rules["createPullRequest"]({"pullRequest": None}, {}) is None


def test_gh_graphql_creates_take_the_title_from_the_input():
    """gh's createPullRequest selects only id and url."""
    from scooter_broker_lib.forge import find_forge_hosts

    rules = find_forge_hosts(github()).graphql_link_rules
    pr = rules["createPullRequest"]({"pullRequest": {"id": "PR_1", "url": "https://github.com/o/r/pull/7"}},
                                    {"input": {"title": "Fix the thing"}})
    assert pr.title == "Fix the thing"
    assert rules["createIssue"]({"issue": {"url": "https://github.com/o/r/issues/8"}}, {}).title is None


def test_forge_policy_is_loaded_from_settings(monkeypatch):
    monkeypatch.setenv("GITHUB_FORGE_POLICY", "scooter_broker_lib.forge:AllowAll")
    from scooter_broker_lib.forge import AllowAll

    assert isinstance(github().forge_policy, AllowAll)
