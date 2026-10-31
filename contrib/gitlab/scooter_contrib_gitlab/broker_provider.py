"""GitLab provider: a PAT via the PRIVATE-TOKEN header, over http-proxy, the forge proxy and the agent tool."""

from __future__ import annotations

from .config import GitlabSettings
from .forge import GitLabDialect, forge_hosts
from .mcp_tools import gitlab_mcp_server
from . import user_auth
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


# Auto-link the MRs and issues an agent creates via the proxy; the project id may be numeric or URL-encoded, and the path starts with `api/v4/` because the upstream is the bare host.
_GITLAB_LINK_RULES = [
    rule(
        "POST", r"^api/v4/projects/[^/]+/merge_requests/?$",
        lambda r: Link(source="gitlab", resource_type="mr", url=r.get("web_url", ""), title=r.get("title")),
    ),
    rule(
        "POST", r"^api/v4/projects/[^/]+/issues/?$",
        lambda r: Link(source="gitlab", resource_type="issue", url=r.get("web_url", ""), title=r.get("title")),
    ),
]


@register_provider
def gitlab(ctx: BrokerContext | None = None) -> Provider:
    # Read at build time, like every provider factory.
    settings = GitlabSettings()
    upstream = f"https://{settings.gitlab_host}"
    enabled = bool(settings.gitlab_token)
    credential = StaticTokenSource(token=settings.gitlab_token, kind="header", header_name="PRIVATE-TOKEN")
    users = user_auth.GitLabUsers(
        host=settings.gitlab_host,
        client_id=settings.gitlab_oauth_client_id,
        client_secret=settings.gitlab_oauth_client_secret,
    )
    transports: list = []
    auth = _user_auth(settings, ctx, users) if enabled else None
    if auth is not None:
        credential = UserFirstSource(resolver=ctx.owners, user_credential=auth.credential, fallback=credential)
        transports.append(auth)
    if enabled:
        _register_commit_identity(user_auth.GitLabBot(users, settings.gitlab_token), auth)

    return Provider(
        name="gitlab",
        credential=credential,
        transports=transports + [
            # A bare-host upstream, so agents call the full API path through the proxy.
            HttpProxy(
                upstream=upstream,
                link_rules=_GITLAB_LINK_RULES,
                agent_host_url=settings.agent_host_url,
            ),
            McpTools(server=gitlab_mcp_server(), upstream=upstream),
            # One host for git and the API; the REST link rules already match `api/v4/...` paths.
            ForgeHosts(
                hosts=forge_hosts(settings.gitlab_host),
                dialect=GitLabDialect(),
                git_username="oauth2",
                link_rules=_GITLAB_LINK_RULES,
            ),
        ],
        enabled=enabled,
        forge_policy=load_policy(settings.gitlab_forge_policy),
    )


def _user_auth(settings: GitlabSettings, ctx: BrokerContext | None, users: user_auth.GitLabUsers) -> user_auth.UserAuth | None:
    """User auth when enabled and the broker supplies what it needs, else None."""
    if not settings.gitlab_user_auth_enabled or ctx is None or ctx.owners is None or ctx.user_secrets is None:
        return None
    auth = user_auth.build(ctx.contrib_store_config("gitlab"), ctx.user_secrets, users, settings.gitlab_oauth_redirect_url)

    @ssh_keys.on_ssh_key_change
    async def _on_key_change(change: ssh_keys.SshKeyChange) -> None:
        await user_auth.on_key_change(auth, users, change)

    return auth


def _register_commit_identity(bot: user_auth.GitLabBot, auth: user_auth.UserAuth | None) -> None:
    @register_commit_identity
    async def _gitlab_identity(user: str | None) -> Person | None:
        if user is None:
            return await bot.person()
        profile = await auth.profile(user) if auth is not None else None
        return Person(profile.name, profile.email) if profile else None
