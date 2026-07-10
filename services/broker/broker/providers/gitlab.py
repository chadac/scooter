"""GitLab provider module — PAT via PRIVATE-TOKEN header, proxy + git-cred."""

from __future__ import annotations

from ..config import settings
from ..core.autolink import Link, rule
from ..core.registry import register_provider
from ..core.types import Provider
from ..sources.static_token import StaticTokenSource
from ..transports.git_credential import GitCredential
from ..transports.http_proxy import HttpProxy


# Auto-link the MRs / issues an agent creates via the proxy. GitLab's create
# responses carry `web_url` (the human link) + `title`. The project id in the path
# may be numeric or URL-encoded (group%2Fproject), so match a non-slash segment.
_GITLAB_LINK_RULES = [
    rule(
        "POST", r"^projects/[^/]+/merge_requests/?$",
        lambda r: Link(source="gitlab", resource_type="mr", url=r.get("web_url", ""), title=r.get("title")),
    ),
    rule(
        "POST", r"^projects/[^/]+/issues/?$",
        lambda r: Link(source="gitlab", resource_type="issue", url=r.get("web_url", ""), title=r.get("title")),
    ),
]


@register_provider
def gitlab() -> Provider:
    return Provider(
        name="gitlab",
        credential=StaticTokenSource(
            token=settings.gitlab_token, kind="header", header_name="PRIVATE-TOKEN"
        ),
        # Specific routes before the HttpProxy catch-all (see github.py).
        transports=[
            GitCredential(host="gitlab.com"),
            HttpProxy(
                upstream="https://gitlab.com/api/v4",
                link_rules=_GITLAB_LINK_RULES,
                agent_host_url=settings.agent_host_url,
            ),
        ],
        enabled=bool(settings.gitlab_token),
    )
