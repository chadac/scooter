"""Brave Search settings, owned by this contrib rather than the broker app."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class BraveSearchSettings(ScooterBaseSettings):
    # The only knob: the upstream host is fixed, so there is no URL setting to
    # get wrong (unlike Grafana, whose stack URL is per-deployment).
    brave_search_api_key: str = ""
