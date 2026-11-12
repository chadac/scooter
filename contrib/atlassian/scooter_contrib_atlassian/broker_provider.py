"""Atlassian provider: the OAuth app's token injected by the forge proxy into the enabled products' API paths.

Mounts no routes. Requests to `api.atlassian.com/ex/<product>/<cloud id>/` get
the token when that product is enabled; any other path there is forwarded with
none. With a site URL, `<site>/rest/…` and `<site>/wiki/…` are rewritten onto
those API paths first, so both URL forms work and policy sees one.
"""

from __future__ import annotations

import logging

from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.forge import ForgeHost, ForgeHosts, Rewrite, load_policy
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.client_credentials import ClientCredentialsSource
from scooter_broker_lib.types import Provider

from .config import API_HOST, PRODUCTS, TOKEN_URL, AtlassianSettings

logger = logging.getLogger(__name__)


@register_provider
def atlassian() -> Provider:
    # Read at build time, once per create_app().
    settings = AtlassianSettings()
    cloud_id = settings.atlassian_cloud_id
    try:
        products = settings.products
        site = settings.site_host
    except ValueError as e:
        logger.error("%s; atlassian provider disabled", e)
        products, site = [], None
    configured = bool(settings.atlassian_client_id and settings.atlassian_client_secret and cloud_id)
    if not configured:
        # Normal when unconfigured: published images ship this contrib everywhere.
        logger.info("Atlassian OAuth client or cloud id not set; atlassian provider disabled")
    return Provider(
        name="atlassian",
        credential=ClientCredentialsSource(
            token_url=TOKEN_URL,
            client_id=settings.atlassian_client_id,
            client_secret=settings.atlassian_client_secret,
        ),
        transports=[ForgeHosts(
            hosts=forge_hosts(cloud_id, products, site),
            link_rules=_link_rules(settings.atlassian_site_url) if "jira" in products else [],
        )],
        enabled=configured and bool(products),
        forge_policy=load_policy(settings.atlassian_forge_policy),
    )


def forge_hosts(cloud_id: str, products: list[str], site: str | None) -> list[ForgeHost]:
    roots = {p: PRODUCTS[p][0].format(cloud_id=cloud_id) for p in products}
    hosts = [ForgeHost(API_HOST, api_prefixes=tuple(roots.values()))]
    if site and site != API_HOST:
        hosts.append(ForgeHost(site, rewrites=tuple(
            Rewrite(PRODUCTS[p][1], API_HOST, roots[p] + PRODUCTS[p][1].lstrip("/")) for p in products
        )))
    return hosts


def _link_rules(site_url: str) -> list:
    site = site_url.rstrip("/")

    def issue(r: dict) -> Link | None:
        # Create returns {id, key, self}; /browse/{key} is the page.
        key = r.get("key")
        if not key:
            return None
        url = f"{site}/browse/{key}" if site else r.get("self", "")
        return Link(source="jira", resource_type="issue", url=url, title=key)

    # /issue/bulk is excluded.
    return [rule("POST", r"^ex/jira/[^/]+/rest/api/[23]/issue/?$", issue)]
