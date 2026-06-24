"""GitLab provider module — PAT via PRIVATE-TOKEN header, proxy + git-cred."""

from __future__ import annotations

from ..config import settings
from ..core.registry import register_provider
from ..core.types import Provider
from ..sources.static_token import StaticTokenSource
from ..transports.git_credential import GitCredential
from ..transports.http_proxy import HttpProxy


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
            HttpProxy(upstream="https://gitlab.com/api/v4"),
        ],
        enabled=bool(settings.gitlab_token),
    )
