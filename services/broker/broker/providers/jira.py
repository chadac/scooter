"""Jira provider module — Atlassian OAuth, http-proxy only."""

from __future__ import annotations

from ..config import settings
from ..core.autolink import Link, rule
from ..core.registry import register_provider
from ..core.types import Provider
from ..sources.atlassian_oauth import AtlassianOAuthSource
from ..transports.http_proxy import HttpProxy


def _jira_issue_link(r: dict) -> Link | None:
    # Create-issue response: {id, key, self}. The API `self` URL isn't a nice
    # human link; prefer the site's /browse/{KEY} when the site URL is configured.
    key = r.get("key")
    if not key:
        return None
    site = settings.jira_site_url.rstrip("/")
    url = f"{site}/browse/{key}" if site else r.get("self", "")
    return Link(source="jira", resource_type="issue", url=url, title=key)


# create-issue = POST /rest/api/{2,3}/issue  (bulk = /issue/bulk, excluded)
_JIRA_LINK_RULES = [
    rule("POST", r"^rest/api/[23]/issue/?$", _jira_issue_link),
]


@register_provider
def jira() -> Provider:
    cloud_id = settings.atlassian_cloud_id
    return Provider(
        name="jira",
        credential=AtlassianOAuthSource(
            client_id=settings.atlassian_client_id,
            client_secret=settings.atlassian_client_secret,
            cloud_id=cloud_id,
        ),
        transports=[
            HttpProxy(
                upstream=f"https://api.atlassian.com/ex/jira/{cloud_id}",
                link_rules=_JIRA_LINK_RULES,
                agent_host_url=settings.agent_host_url,
            ),
        ],
        enabled=bool(settings.atlassian_client_id and cloud_id),
    )
