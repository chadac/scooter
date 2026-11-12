"""Atlassian provider: the OAuth app's token injected by the forge proxy into the enabled products' API paths.

Mounts no routes. Requests to `api.atlassian.com/ex/<product>/<cloud id>/` get
the token when that product is enabled; any other path there is forwarded with
none.
"""

from __future__ import annotations

import logging

from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.forge import ForgeHost, ForgeHosts, load_policy
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_contrib_jira.atlassian_oauth import AtlassianOAuthSource

from .config import API_HOST, PRODUCTS, AtlassianSettings

logger = logging.getLogger(__name__)


@register_provider
def atlassian() -> Provider:
    # Read at build time, once per create_app().
    settings = AtlassianSettings()
    cloud_id = settings.atlassian_cloud_id
    try:
        products = settings.products
    except ValueError as e:
        logger.error("%s; atlassian provider disabled", e)
        products = []
    configured = bool(settings.atlassian_client_id and settings.atlassian_client_secret and cloud_id)
    if not configured:
        # Normal when unconfigured: published images ship this contrib everywhere.
        logger.info("Atlassian OAuth client or cloud id not set; atlassian provider disabled")
    return Provider(
        name="atlassian",
        credential=AtlassianOAuthSource(
            client_id=settings.atlassian_client_id,
            client_secret=settings.atlassian_client_secret,
            cloud_id=cloud_id,
        ),
        transports=[ForgeHosts(
            hosts=[ForgeHost(API_HOST, api_prefixes=tuple(PRODUCTS[p].format(cloud_id=cloud_id) for p in products))],
            link_rules=_link_rules(settings.atlassian_site_url) if "jira" in products else [],
        )],
        enabled=configured and bool(products),
        forge_policy=load_policy(settings.atlassian_forge_policy),
    )


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
