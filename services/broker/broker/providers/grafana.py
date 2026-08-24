"""Grafana provider module — bearer-token auth, http-proxy only.

Proxies /grafana/* -> https://<stack>.grafana.net with the service-account token
injected, so the agent can query dashboards, datasources, and (via the datasource
proxy) Prometheus/Loki WITHOUT ever seeing the token.

Enabled iff both the URL and the token are configured. The URL is stack-specific
(e.g. https://myorg.grafana.net), so it is config rather than a fixed upstream.

Typical agent usage — note these are the paths the PROXY sees, so they start
after /grafana/:
    GET  api/datasources
    POST api/ds/query                       (unified query endpoint)
    GET  api/search?query=&type=dash-db     (list dashboards)
"""

from __future__ import annotations

from ..config import settings
from ..core.registry import register_provider
from ..core.types import Provider
from ..sources.static_token import StaticTokenSource
from ..transports.http_proxy import HttpProxy


@register_provider
def grafana() -> Provider:
    url = (settings.grafana_url or "").strip().rstrip("/")
    return Provider(
        name="grafana",
        # Grafana service-account tokens are plain bearer tokens (unlike GitLab's
        # PRIVATE-TOKEN header), so the default kind is right.
        credential=StaticTokenSource(token=settings.grafana_token),
        transports=[HttpProxy(upstream=url)],
        enabled=bool(url and settings.grafana_token),
    )
