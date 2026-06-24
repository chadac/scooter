"""GitHub provider module.

Declares: GitHub App (or PAT fallback) credential source + two transports —
http-proxy to api.github.com AND a git-credential helper for github.com. Both
routes (/github/{path} and /github/git-credentials) fall out automatically.
"""

from __future__ import annotations

from ..config import settings
from ..core.registry import register_provider
from ..core.types import Provider
from ..sources.github_app import GitHubAppSource
from ..sources.static_token import StaticTokenSource
from ..transports.git_credential import GitCredential
from ..transports.http_proxy import HttpProxy


@register_provider
def github() -> Provider:
    if settings.github_app_id and settings.github_app_private_key:
        credential = GitHubAppSource(
            app_id=settings.github_app_id,
            private_key=settings.github_app_private_key,
            installation_id=settings.github_app_installation_id,
        )
        enabled = True
    elif settings.github_token:
        credential = StaticTokenSource(token=settings.github_token)
        enabled = True
    else:
        credential = StaticTokenSource(token="")
        enabled = False  # no GitHub config -> off

    return Provider(
        name="github",
        credential=credential,
        # ORDER MATTERS: specific routes (git-credentials) MUST be registered
        # before the HttpProxy's `/{path:path}` catch-all, otherwise the proxy
        # shadows /github/git-credentials and forwards it to api.github.com
        # (404). FastAPI matches routes in registration order.
        transports=[
            GitCredential(host="github.com", username="x-access-token"),
            HttpProxy(upstream="https://api.github.com"),
        ],
        enabled=enabled,
    )
