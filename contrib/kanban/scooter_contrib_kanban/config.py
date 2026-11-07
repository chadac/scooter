"""kanban settings, rendered from contribs.kanban by its contrib.nix."""

from __future__ import annotations

import json

from scooter_lib.settings import ScooterBaseSettings

DEFAULT_STAGES = '["Design","In progress","Review","Done"]'


class KanbanSettings(ScooterBaseSettings):
    kanban_enabled: bool = False
    # JSON list of a new board's stage names.
    kanban_stages: str = DEFAULT_STAGES
    # A card untouched this long gets one end-of-run reminder.
    kanban_stale_after_seconds: int = 1800


def parse_stages(raw: str) -> list[str]:
    """The configured starting stages; a malformed value falls back to the defaults."""
    try:
        stages = [s.strip() for s in json.loads(raw) if isinstance(s, str) and s.strip()]
    except (ValueError, TypeError):
        stages = []
    return stages or json.loads(DEFAULT_STAGES)


settings = KanbanSettings()
