"""Atlassian provider: the OAuth app's token injected by the forge proxy into the enabled products' API paths, and Confluence's tools.

Requests to `api.atlassian.com/ex/<product>/<cloud id>/` get the token when that
product is enabled; any other path there is forwarded with none. The Confluence
tools call through the same provider, so `forgePolicy` covers them too.
"""

from __future__ import annotations

import logging

from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.forge import ForgeHost, ForgeHosts, load_policy
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider
from scooter_contrib_jira.atlassian_oauth import AtlassianOAuthSource

from . import confluence
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
            link_rules=_link_rules(settings.atlassian_site_url, products),
        )] + ([McpTools(
            server=confluence.confluence_mcp_server(),
            upstream=f"https://{API_HOST}/ex/confluence/{cloud_id}",
        )] if "confluence" in products else []),
        enabled=configured and bool(products),
        forge_policy=load_policy(settings.atlassian_forge_policy),
    )


def _link_rules(site_url: str, products: list[str]) -> list:
    site = site_url.rstrip("/")

    def issue(r: dict) -> Link | None:
        # Create returns {id, key, self}; /browse/{key} is the page.
        key = r.get("key")
        if not key:
            return None
        url = f"{site}/browse/{key}" if site else r.get("self", "")
        return Link(source="jira", resource_type="issue", url=url, title=key)

    def v1_page(r: dict) -> Link | None:
        # v1 /content also creates blog posts, comments and attachments.
        return confluence.page_link(r, site) if r.get("type") == "page" else None

    rules = []
    if "jira" in products:
        # /issue/bulk is excluded.
        rules.append(rule("POST", r"^ex/jira/[^/]+/rest/api/[23]/issue/?$", issue))
    if "confluence" in products:
        rules += [
            rule("POST", r"^ex/confluence/[^/]+/wiki/api/v2/pages/?$", lambda r: confluence.page_link(r, site)),
            rule("POST", r"^ex/confluence/[^/]+/wiki/rest/api/content/?$", v1_page),
        ]
    return rules
