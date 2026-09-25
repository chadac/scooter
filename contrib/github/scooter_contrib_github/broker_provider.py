"""GitHub provider module.

Declares: GitHub App (or PAT fallback) credential source + two transports —
http-proxy to api.github.com AND a git-credential helper for github.com. Both
routes (/github/{path} and /github/git-credentials) fall out automatically.
"""

from __future__ import annotations

from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.git_credential import GitCredential
from scooter_broker_lib.transports.http_proxy import HttpProxy

from .config import GitHubSettings
from .github_app import GitHubAppSource


# Auto-link the PRs / issues an agent creates via the proxy. GitHub's create
# responses carry `html_url` (the human link) + `title`. The /issues create
# endpoint only makes issues (a PR is created via /pulls), so the two are distinct.
_GITHUB_LINK_RULES = [
    rule(
        "POST", r"^repos/[^/]+/[^/]+/pulls/?$",
        lambda r: Link(source="github", resource_type="pr", url=r.get("html_url", ""), title=r.get("title")),
    ),
    rule(
        "POST", r"^repos/[^/]+/[^/]+/issues/?$",
        lambda r: Link(source="github", resource_type="issue", url=r.get("html_url", ""), title=r.get("title")),
    ),
]


@register_provider
def github() -> Provider:
    # Read at BUILD time, like every provider factory (#573).
    settings = GitHubSettings()
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
            HttpProxy(
                upstream="https://api.github.com",
                link_rules=_GITHUB_LINK_RULES,
                agent_host_url=settings.agent_host_url,
            ),
        ],
        enabled=enabled,
    )
