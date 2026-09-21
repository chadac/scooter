"""Datadog provider module — two-key header auth, http-proxy only.

Proxies /datadog/* -> https://api.<site> with DD-API-KEY + DD-APPLICATION-KEY
injected, so the agent can query metrics/logs/monitors without seeing the keys.
Enabled iff BOTH keys are configured. The site is region-specific (config).
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.transports.http_proxy import HttpProxy

from .config import DatadogSettings
from .datadog_keys import DatadogKeysSource


@register_provider
def datadog() -> Provider:
    # Read at BUILD time, like every provider factory — the broker calls this
    # once per create_app(), after refreshing the environment.
    settings = DatadogSettings()
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
