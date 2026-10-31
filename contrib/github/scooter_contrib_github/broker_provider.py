"""GitHub provider: a GitHub App (or PAT fallback) credential source, an http-proxy to api.github.com, the forge-proxy hosts, and the agent tool."""

from __future__ import annotations

from scooter_broker_lib import ssh_keys
from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.commit_identity import Person, register_commit_identity
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.forge import ForgeHosts, load_policy
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.sources.user_first import UserFirstSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.transports.mcp_tools import McpTools

from .config import GitHubSettings
from .forge import GitHubDialect, api_base, forge_hosts
from .github_app import GitHubAppSource
from .mcp_tools import github_mcp_server
from . import user_auth


# Auto-link the PRs and issues an agent creates via the proxy; the create responses carry `html_url` and `title`.
_GITHUB_LINK_RULES = [
    rule(
        "POST", r"^(?:api/v3/)?repos/[^/]+/[^/]+/pulls/?$",
        lambda r: Link(source="github", resource_type="pr", url=r.get("html_url", ""), title=r.get("title")),
    ),
    rule(
        "POST", r"^(?:api/v3/)?repos/[^/]+/[^/]+/issues/?$",
        lambda r: Link(source="github", resource_type="issue", url=r.get("html_url", ""), title=r.get("title")),
    ),
]


# The same creates made by `gh` through the forge proxy, which uses GraphQL for most of them.
def _graphql_link(field: str, resource_type: str):
    def link(data: dict) -> Link | None:
        node = (data or {}).get(field) or {}
        url = node.get("url")
        return Link(source="github", resource_type=resource_type, url=url, title=node.get("title")) if url else None
    return link


_GITHUB_GRAPHQL_LINK_RULES = {
    "createPullRequest": _graphql_link("pullRequest", "pr"),
    "createIssue": _graphql_link("issue", "issue"),
}

@register_provider
def github(ctx: BrokerContext | None = None) -> Provider:
    # Read at build time, like every provider factory.
    settings = GitHubSettings()
    upstream = api_base(settings.github_host)
    if settings.github_app_id and settings.github_app_private_key:
        credential = GitHubAppSource(
            app_id=settings.github_app_id,
            private_key=settings.github_app_private_key,
            installation_id=settings.github_app_installation_id,
            owners=settings.app_owners,
            api_base=upstream,
        )
        enabled = True
    elif settings.github_token:
        credential = StaticTokenSource(token=settings.github_token)
        enabled = True
    else:
        credential = StaticTokenSource(token="")
        enabled = False

    transports: list = []
    bot = user_auth.GitHubBot(credential, settings.github_host) if isinstance(credential, GitHubAppSource) else None
    auth = _user_auth(settings, ctx) if enabled else None
    if auth is not None:
        credential = UserFirstSource(resolver=ctx.owners, user_credential=auth.credential, fallback=credential)
        transports.append(auth)
    if enabled:
        _register_commit_identity(bot, auth)

    return Provider(
        name="github",
        credential=credential,
        transports=transports + [
            HttpProxy(
                upstream=upstream,
                link_rules=_GITHUB_LINK_RULES,
                agent_host_url=settings.agent_host_url,
            ),
            # The agent tool shares the proxy's upstream so the two cannot drift.
            McpTools(server=github_mcp_server(), upstream=upstream),
            ForgeHosts(
                hosts=forge_hosts(settings.github_host),
                dialect=GitHubDialect(),
                git_username="x-access-token",
                link_rules=_GITHUB_LINK_RULES,
                graphql_link_rules=_GITHUB_GRAPHQL_LINK_RULES,
            ),
        ],
        enabled=enabled,
        forge_policy=load_policy(settings.github_forge_policy),
    )


def _user_auth(settings: GitHubSettings, ctx: BrokerContext | None) -> user_auth.UserAuth | None:
    """User auth when enabled and the broker supplies what it needs, else None."""
    if not settings.github_user_auth_enabled or ctx is None or ctx.owners is None or ctx.user_secrets is None:
        return None
    users = user_auth.GitHubUsers(
        host=settings.github_host,
        client_id=settings.github_app_client_id,
        client_secret=settings.github_app_client_secret,
    )
    auth = user_auth.build(ctx.contrib_store_config("github"), ctx.user_secrets, users, settings.github_oauth_redirect_url)

    @ssh_keys.on_ssh_key_change
    async def _on_key_change(change: ssh_keys.SshKeyChange) -> None:
        await user_auth.on_key_change(auth, users, change)

    return auth


def _register_commit_identity(bot: user_auth.GitHubBot | None, auth: user_auth.UserAuth | None) -> None:
    @register_commit_identity
    async def _github_identity(user: str | None) -> Person | None:
        if user is None:
            return await bot.person() if bot is not None else None
        profile = await auth.profile(user) if auth is not None else None
        return Person(profile.name, profile.email) if profile else None
