"""Jira provider module — Atlassian OAuth, http-proxy only."""

from __future__ import annotations

from ..core.registry import register_provider
from ..core.types import Provider
from ..sources.atlassian_oauth import AtlassianOAuthSource
from ..transports.http_proxy import HttpProxy


@register_provider
def jira() -> Provider:
    cloud_id = ...  # from config
    return Provider(
        name="jira",
        credential=AtlassianOAuthSource(client_id=..., client_secret=..., cloud_id=cloud_id),
        transports=[
            HttpProxy(upstream=f"https://api.atlassian.com/ex/jira/{cloud_id}"),
        ],
    )
