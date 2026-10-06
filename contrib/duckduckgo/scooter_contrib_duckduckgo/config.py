"""DuckDuckGo settings, owned by this contrib rather than the broker app."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class DuckduckgoSettings(ScooterBaseSettings):
    # The ONLY search provider whose gate is a flag rather than a key, because there is
    # no key: DDG publishes no results API and this reads the public HTML page. So the
    # operator has to ask for it — default off means no deployment starts scraping a
    # search engine because it happened to build this contrib in.
    duckduckgo_enabled: bool = False
