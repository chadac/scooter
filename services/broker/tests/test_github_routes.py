"""Regression test: the github provider's git-credentials route must NOT be
shadowed by its HttpProxy catch-all.

The github provider mounts BOTH a GitCredential transport (/github/git-credentials)
and an HttpProxy transport (/github/{path:path}, all methods). FastAPI matches in
registration order, so GitCredential MUST come first — otherwise the proxy
catches /github/git-credentials and forwards it to api.github.com (404), and the
in-pod git-credential-broker helper gets nothing -> git can't authenticate.

Tested at the provider level (no settings/env singleton games): the github
provider's first transport must be the GitCredential one.
"""

from __future__ import annotations

from broker.providers.github import github
from broker.transports.git_credential import GitCredential
from broker.transports.http_proxy import HttpProxy


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
