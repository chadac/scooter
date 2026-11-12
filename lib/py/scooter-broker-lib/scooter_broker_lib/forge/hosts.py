"""forge-proxy transport: the hosts a provider's credential is injected into by the broker's egress proxy.

Mounts no routes. The broker's ForgeProxy server (services/broker/broker/forge/)
collects every enabled provider's `ForgeHosts`, intercepts TLS for exactly those
hosts and injects the provider's credential, so `git`, `gh` and `glab` work against
the real hostnames while the token never enters the sandbox.
"""

from __future__ import annotations

import base64
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import httpx
from fastapi import APIRouter

from ..autolink import Link, LinkRule
from ..types import AuthDependency, Credential, Provider, Transport
from .parse import ForgeDialect, GenericDialect

if TYPE_CHECKING:
    from ..types import Identity
    from .policy import ForgeRequest, Via


@dataclass(frozen=True)
class Rewrite:
    """Requests under `prefix` go to `upstream_host`, with `prefix` replaced by `upstream_prefix`."""

    prefix: str
    upstream_host: str
    upstream_prefix: str


@dataclass(frozen=True)
class ForgeHost:
    """One intercepted host: whether it serves git smart-HTTP, and which path prefixes are its API."""

    host: str
    git: bool = False
    # Paths that get the API credential; ("/",) for an API-only host.
    api_prefixes: tuple[str, ...] = ()
    # Applied before classifying; targets must be this ForgeHosts' hosts.
    rewrites: tuple[Rewrite, ...] = ()

    def rewrite(self, path: str) -> tuple[str, str] | None:
        """The (host, path) a request for `path` goes to instead, or None to send it here unchanged."""
        for r in self.rewrites:
            if path.startswith(r.prefix):
                return r.upstream_host, r.upstream_prefix + path[len(r.prefix):]
        return None


# A GraphQL mutation's top-level field -> the created resource, from its `data` entry and the request's variables.
GraphQLLinkRule = Callable[[dict, dict], Link | None]


@dataclass
class ForgeHosts(Transport):
    hosts: list[ForgeHost] = field(default_factory=list)
    # Repo and GraphQL parsing for this forge's API.
    dialect: ForgeDialect = field(default_factory=GenericDialect)
    # The basic-auth username git smart-HTTP pairs with the token.
    git_username: str = "x-access-token"
    # Auto-linking for creates made through the proxy: REST rules match the path without its leading "/".
    link_rules: list[LinkRule] = field(default_factory=list)
    graphql_link_rules: dict[str, GraphQLLinkRule] = field(default_factory=dict)
    name: str = "forge-proxy"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        return APIRouter()

    def inject_git(self, request: httpx.Request, cred: Credential) -> None:
        """git smart-HTTP and LFS take basic auth, whatever header the API wants."""
        basic = base64.b64encode(f"{self.git_username}:{cred.value}".encode()).decode()
        request.headers["Authorization"] = f"Basic {basic}"


def find_forge_hosts(provider: Provider) -> ForgeHosts | None:
    return next((t for t in provider.transports if isinstance(t, ForgeHosts)), None)


def api_forge_request(
    provider: Provider,
    identity: "Identity",
    *,
    via: "Via",
    method: str,
    url: httpx.URL,
    body: bytes | None = None,
) -> "ForgeRequest | None":
    """The ForgeRequest for an API call the broker makes for a provider, or None when the provider is not a forge."""
    from .parse import classify, parse_graphql_body
    from .policy import ForgeRequest

    forge = find_forge_hosts(provider)
    if forge is None:
        return None
    path = url.raw_path.decode("ascii", "replace").split("?", 1)[0] or "/"
    query = url.query.decode("ascii", "replace")
    host = next((h for h in forge.hosts if h.host == url.host), None)
    c = classify(
        dialect=forge.dialect,
        git=host.git if host else False,
        api_prefixes=host.api_prefixes if host else ("/",),
        path=path,
        query=query,
    )
    graphql = graphql_body = None
    if method.upper() == "POST" and forge.dialect.is_graphql(path):
        graphql_body = body or b""
        graphql = parse_graphql_body(graphql_body)
    return ForgeRequest(
        identity=identity,
        provider=provider.name,
        via=via,
        method=method.upper(),
        host=url.host,
        path=path,
        query=query,
        kind=c.kind,
        repo=c.repo,
        git_service=c.git_service,
        graphql=graphql,
        graphql_body=graphql_body,
    )
