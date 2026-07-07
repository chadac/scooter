"""Datadog provider module — two-key header auth, http-proxy only.

Proxies /datadog/* -> https://api.<site> with DD-API-KEY + DD-APPLICATION-KEY
injected, so the agent can query metrics/logs/monitors without seeing the keys.
Enabled iff BOTH keys are configured. The site is region-specific (config).
"""

from __future__ import annotations

from ..config import settings
from ..core.registry import register_provider
from ..core.types import Provider
from ..sources.datadog_keys import DatadogKeysSource
from ..transports.http_proxy import HttpProxy


@register_provider
def datadog() -> Provider:
    site = (settings.datadog_site or "datadoghq.com").strip().lstrip(".")
    return Provider(
        name="datadog",
        credential=DatadogKeysSource(
            api_key=settings.datadog_api_key,
            app_key=settings.datadog_app_key,
        ),
        transports=[HttpProxy(upstream=f"https://api.{site}")],
        enabled=bool(settings.datadog_api_key and settings.datadog_app_key),
    )
