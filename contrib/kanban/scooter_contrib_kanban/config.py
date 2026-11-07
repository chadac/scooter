"""kanban settings, rendered from contribs.kanban by its contrib.nix."""

from __future__ import annotations

import json
from dataclasses import dataclass

from scooter_lib.settings import ScooterBaseSettings

DEFAULT_COLUMNS = '[{"id":"design","label":"Design"},{"id":"in-progress","label":"In progress"},{"id":"review","label":"Review"},{"id":"done","label":"Done"}]'


class KanbanSettings(ScooterBaseSettings):
    kanban_enabled: bool = False
    # JSON list of {id, label}, in board order.
    kanban_columns: str = DEFAULT_COLUMNS
    # A card untouched this long gets one end-of-run reminder.
    kanban_stale_after_seconds: int = 1800


@dataclass(frozen=True)
class Column:
    id: str
    label: str


def parse_columns(raw: str) -> list[Column]:
    """The configured columns; a malformed value falls back to the defaults."""
    try:
        cols = [Column(id=str(c["id"]), label=str(c["label"])) for c in json.loads(raw)]
    except (ValueError, TypeError, KeyError):
        cols = []
    if not cols:
        cols = [Column(**c) for c in json.loads(DEFAULT_COLUMNS)]
    return cols


settings = KanbanSettings()
