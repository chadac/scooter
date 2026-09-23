"""Grafana settings, owned by this contrib rather than the broker app.

Same env vars the broker read before (GRAFANA_URL / GRAFANA_TOKEN), so a
deployment needs no manifest change. Why: PR #573.
"""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class GrafanaSettings(ScooterBaseSettings):
    # Stack-specific base URL (e.g. https://myorg.grafana.net), so it is config
    # rather than a fixed upstream. A trailing slash is stripped by the provider.
    grafana_url: str = ""
    grafana_token: str = ""
