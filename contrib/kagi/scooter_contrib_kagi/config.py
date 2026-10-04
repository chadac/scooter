"""Kagi settings, owned by this contrib rather than the broker app."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class KagiSettings(ScooterBaseSettings):
    # The RAW key, without Kagi's `Bot ` scheme prefix — the provider adds that.
    # Keeping the setting raw means a deployment pastes exactly what Kagi's
    # dashboard shows.
    kagi_api_key: str = ""
