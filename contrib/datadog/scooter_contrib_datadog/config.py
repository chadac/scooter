"""Datadog settings, owned by this contrib rather than the broker app.

Same env vars the broker read before (DATADOG_API_KEY / DATADOG_APP_KEY /
DATADOG_SITE), so a deployment needs no manifest change. Why: PR #573.
"""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class DatadogSettings(ScooterBaseSettings):
    datadog_api_key: str = ""
    datadog_app_key: str = ""
    # Region-specific: datadoghq.com | datadoghq.eu | us3/us5.datadoghq.com |
    # ap1.datadoghq.com | ddog-gov.com.
    datadog_site: str = "datadoghq.com"
