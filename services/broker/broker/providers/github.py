"""GitHub provider module.

Declares: GitHub App (or PAT fallback) credential source + two transports —
http-proxy to api.github.com AND a git-credential helper for github.com. Both
routes (/github/{path} and /github/git-credentials) fall out automatically.

Design stage: factory shape only.
"""

from __future__ import annotations

from ..core.registry import register_provider
from ..core.types import Provider
from ..sources.github_app import GitHubAppSource
from ..sources.static_token import StaticTokenSource
from ..transports.git_credential import GitCredential
from ..transports.http_proxy import HttpProxy


@register_provider
def github() -> Provider:
    # credential = GitHubAppSource(...) if app configured else StaticTokenSource(PAT)
    return Provider(
        name="github",
        credential=...,  # GitHubAppSource | StaticTokenSource, from config
        transports=[
            HttpProxy(upstream="https://api.github.com"),
            GitCredential(host="github.com", username="x-access-token"),
        ],
    )
