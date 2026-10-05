"""Brave settings, owned by this contrib rather than the broker app."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class BraveSettings(ScooterBaseSettings):
    # The subscription token from https://api-dashboard.search.brave.com. Empty ⇒ this
    # provider is disabled, so `web_search` is not listed at all.
    brave_search_api_key: str = ""
