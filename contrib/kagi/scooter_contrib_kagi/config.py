"""Kagi settings, owned by this contrib rather than the broker app."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class KagiSettings(ScooterBaseSettings):
    # An API token from a paid Kagi account (https://kagi.com/settings?p=api). Empty ⇒
    # this provider is disabled, so `web_search` is not listed at all.
    kagi_api_key: str = ""
