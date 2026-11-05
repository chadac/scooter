"""skills settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class SkillsSettings(ScooterBaseSettings):
    skills_enabled: bool = False
