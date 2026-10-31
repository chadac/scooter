"""ssh settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class SshSettings(ScooterBaseSettings):
    ssh_enabled: bool = False
