"""Grafana provider module — bearer-token auth, http-proxy only.

Proxies /grafana/* -> the configured Grafana stack with the service-account token
injected, so the agent can query dashboards, datasources and (through the
datasource proxy) Prometheus/Loki without ever seeing it. Enabled iff BOTH the
stack URL and the token are configured.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy

from .config import GrafanaSettings


@register_provider
def grafana() -> Provider:
    # Read at BUILD time, like every provider factory — the broker calls this
    # once per create_app(), after refreshing the environment.
    settings = GrafanaSettings()
    url = (settings.grafana_url or "").strip().rstrip("/")
    return Provider(
        name="grafana",
        # Grafana service-account tokens are plain bearer tokens (unlike GitLab's
        # PRIVATE-TOKEN header), so the default kind is right.
        credential=StaticTokenSource(token=settings.grafana_token),
        transports=[HttpProxy(upstream=url)],
        enabled=bool(url and settings.grafana_token),
    )
