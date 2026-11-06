"""handoff settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class HandoffSettings(ScooterBaseSettings):
    handoff_enabled: bool = False
    handoff_public_base_url: str = ""
    # The conversation's owner approves each spawn before it happens.
    handoff_require_approval: bool = True


settings = HandoffSettings()
