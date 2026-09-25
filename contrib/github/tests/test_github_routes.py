"""Regression test: the github provider's git-credentials route must NOT be
shadowed by its HttpProxy catch-all.

The github provider mounts BOTH a GitCredential transport (/github/git-credentials)
and an HttpProxy transport (/github/{path:path}, all methods). FastAPI matches in
registration order, so GitCredential MUST come first — otherwise the proxy
catches /github/git-credentials and forwards it to api.github.com (404), and the
in-pod git-credential-broker helper gets nothing -> git can't authenticate.

Tested at the provider level (no settings/env singleton games): the github
provider's first transport must be the GitCredential one.

Moved here with the provider (PR #591): the App source it composes came too, so
this is where the composition is now proved.
"""

from __future__ import annotations

from scooter_contrib_github.broker_provider import github
from scooter_broker_lib.transports.git_credential import GitCredential
from scooter_broker_lib.transports.http_proxy import HttpProxy


def test_git_credential_transport_precedes_proxy():
    provider = github()
    kinds = [type(t).__name__ for t in provider.transports]
    assert "GitCredential" in kinds, kinds
    assert "HttpProxy" in kinds, kinds
    # Specific route before the catch-all proxy.
    assert kinds.index("GitCredential") < kinds.index("HttpProxy"), (
        f"GitCredential must come before HttpProxy, got {kinds}"
    )


def test_git_credential_serves_github_host():
    provider = github()
    gc = next(t for t in provider.transports if isinstance(t, GitCredential))
    assert gc.host == "github.com"
    assert gc.username == "x-access-token"


def test_proxy_targets_github_api():
    provider = github()
    proxy = next(t for t in provider.transports if isinstance(t, HttpProxy))
    assert "api.github.com" in proxy.upstream


def test_git_credentials_are_vended_by_the_app_source(monkeypatch):
    """The end of the `git clone` chain, now that the App source lives here.

    git-credential-broker -> GET /github/git-credentials -> the GENERIC
    GitCredential transport (still in scooter_broker_lib) -> provider.credential.
    Only that last link is github's, so the move must leave the transport reading
    a GitHubAppSource. Why: PR #591.
    """
    from scooter_contrib_github.github_app import GitHubAppSource

    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "42")

    provider = github()
    assert provider.enabled
    assert isinstance(provider.credential, GitHubAppSource)
    assert provider.credential.installation_id == 42
