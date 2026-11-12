"""GitHub's shape for the forge proxy: its hosts and how its API names repos."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING
from urllib.parse import unquote

if TYPE_CHECKING:
    from scooter_broker_lib.forge import ForgeHost

DOTCOM = "github.com"
# GHES serves REST under /api/v3; github.com on api.github.com.
_API_REPO = re.compile(r"^/(?:api/v3/)?repos/(?P<owner>[^/]+)/(?P<name>[^/]+)")


@dataclass(frozen=True)
class GitHubDialect:
    def api_repo(self, path: str) -> str | None:
        m = _API_REPO.match(path if path.startswith("/") else "/" + path)
        return f"{unquote(m.group('owner'))}/{unquote(m.group('name'))}" if m else None

    def is_graphql(self, path: str) -> bool:
        return ("/" + path.lstrip("/")) in ("/graphql", "/api/graphql")


def api_base(host: str) -> str:
    """The REST base URL for github.com or a GHES host."""
    return "https://api.github.com" if host == DOTCOM else f"https://{host}/api/v3"


def graphql_url(host: str) -> str:
    """The GraphQL endpoint for github.com or a GHES host."""
    return "https://api.github.com/graphql" if host == DOTCOM else f"https://{host}/api/graphql"


def forge_hosts(host: str) -> list[ForgeHost]:
    """github.com splits git, API and uploads; GHES uses one host."""
    # Lazy: webhooks imports this module but doesn't ship the broker lib.
    from scooter_broker_lib.forge import ForgeHost
    if host == DOTCOM:
        return [
            ForgeHost(DOTCOM, git=True),
            ForgeHost("api.github.com", api_prefixes=("/",)),
            ForgeHost("uploads.github.com", api_prefixes=("/",)),
        ]
    return [ForgeHost(host, git=True, api_prefixes=("/api/",))]
